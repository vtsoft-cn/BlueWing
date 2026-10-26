package softether

import (
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"slices"
	"sync"
	"time"

	protocol "github.com/mythologyli/zju-connect/client/softether/internal"
)

// Refresh the idle deadline for every underlying TLS read, including protocol
// keepalives that FrameStream consumes internally without returning an IP frame.
type idleTimeoutConn struct{ net.Conn }

func (c idleTimeoutConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	return c.Conn.Read(b)
}

// packetConn is the IPv4 boundary to the existing private gVisor stack.
// It never creates a Windows adapter or changes a route/DNS setting.
type packetConn struct {
	conn        net.Conn
	stream      *protocol.FrameStream
	mac         [6]byte
	lease       protocol.DHCPLease
	in, out     chan []byte
	done        chan struct{}
	once        sync.Once
	stopContext func() bool
	mu          sync.Mutex
	neighbors   map[netip.Addr][6]byte
	renewXID    uint32
	renewed     time.Time
}

func newPacketConn(conn net.Conn, stream *protocol.FrameStream, mac [6]byte, lease protocol.DHCPLease) *packetConn {
	return &packetConn{conn: conn, stream: stream, mac: mac, lease: lease, in: make(chan []byte, 128), out: make(chan []byte, 128), done: make(chan struct{}), neighbors: make(map[netip.Addr][6]byte), renewed: time.Now()}
}
func (p *packetConn) Close() error {
	var err error
	p.once.Do(func() { close(p.done); err = p.conn.Close() })
	return err
}
func (p *packetConn) Read(b []byte) (int, error) {
	select {
	case <-p.done:
		return 0, net.ErrClosed
	default:
	}
	select {
	case <-p.done:
		return 0, net.ErrClosed
	case data := <-p.in:
		if len(data) > len(b) {
			return 0, io.ErrShortBuffer
		}
		return copy(b, data), nil
	}
}
func (p *packetConn) Write(data []byte) (int, error) {
	if len(data) < 20 || len(data) > 1500 || data[0]>>4 != 4 {
		return 0, io.ErrShortBuffer
	}
	select {
	case <-p.done:
		return 0, net.ErrClosed
	default:
	}
	select {
	case <-p.done:
		return 0, net.ErrClosed
	case p.out <- slices.Clone(data):
		return len(data), nil
	}
}
func (p *packetConn) run() {
	defer p.Close()
	defer func() {
		if p.stopContext != nil {
			p.stopContext()
		}
	}()
	go p.send()
	go p.keepAlive()
	for {
		frames, err := p.stream.ReadFrames()
		if err != nil {
			return
		}
		for _, frame := range frames {
			p.mu.Lock()
			if source, mac, ok := protocol.FrameSource(frame); ok && source.Is4() && !source.IsUnspecified() {
				if len(p.neighbors) > 1024 {
					clear(p.neighbors)
				}
				p.neighbors[source] = mac
			}
			xid := p.renewXID
			p.mu.Unlock()
			if xid != 0 {
				lease, ok, err := protocol.RenewalReply(frame, p.mac, xid)
				if err != nil {
					return
				}
				if ok {
					// Reconnect through the manager if network parameters change, so
					// stale DNS/resources are never silently retained.
					if lease.Address != p.lease.Address || lease.Gateway != p.lease.Gateway || !slices.Equal(lease.DNS, p.lease.DNS) || !slices.Equal(lease.Routes, p.lease.Routes) {
						return
					}
					p.mu.Lock()
					p.renewed = time.Now()
					p.lease.Lifetime = lease.Lifetime
					p.renewXID = 0
					p.mu.Unlock()
					continue
				}
			}
			if reply, ok := protocol.ARPReply(frame, p.mac, p.lease.Address.Addr()); ok {
				if err := p.writeFrames(reply); err != nil {
					return
				}
				continue
			}
			// Only accept packets addressed to this leased IPv4. Ignore unrelated
			// broadcast traffic and IPv6 rather than feeding it into the IPv4 stack.
			if len(frame) < 34 || frame[12] != 8 || frame[13] != 0 {
				continue
			}
			ip := frame[14:]
			dest, ok := protocol.IPDestination(ip)
			if !ok || dest != p.lease.Address.Addr() {
				continue
			}
			select {
			case p.in <- slices.Clone(ip):
			case <-p.done:
				return
			default:
			} // bounded ingress
		}
	}
}
func (p *packetConn) writeFrames(frames ...[]byte) error {
	_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return p.stream.WriteFrames(frames...)
}
func (p *packetConn) send() {
	defer p.Close()
	for {
		select {
		case <-p.done:
			return
		case ip := <-p.out:
			dest, ok := protocol.IPDestination(ip)
			if !ok {
				continue
			}
			next := dest
			if !p.lease.Address.Masked().Contains(dest) && p.lease.Gateway.Is4() {
				next = p.lease.Gateway
			}
			var mac [6]byte
			for attempt := 0; attempt < 4; attempt++ {
				p.mu.Lock()
				mac = p.neighbors[next]
				p.mu.Unlock()
				if mac != ([6]byte{}) {
					break
				}
				if err := p.writeFrames(protocol.ARPRequest(p.mac, p.lease.Address.Addr(), next)); err != nil {
					return
				}
				select {
				case <-time.After(300 * time.Millisecond):
				case <-p.done:
					return
				}
			}
			if mac == ([6]byte{}) {
				continue
			} // gVisor retransmits; never broadcast IP payloads
			if err := p.writeFrames(protocol.WrapIPv4(ip, p.mac, mac)); err != nil {
				return
			}
		}
	}
}
func (p *packetConn) keepAlive() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer p.Close()
	n := 0
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			n++
			if n%10 == 0 {
				_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if p.stream.WriteKeepAlive() != nil {
					return
				}
			}
			p.mu.Lock()
			elapsed, xid, lifetime := time.Since(p.renewed), p.renewXID, p.lease.Lifetime
			p.mu.Unlock()
			// Missing lease time cannot be assumed infinite.
			if lifetime == 0 {
				lifetime = time.Hour
			}
			if elapsed >= lifetime {
				return
			}
			if elapsed >= lifetime/2 && (xid == 0 || n%10 == 0) {
				if xid == 0 {
					var b [4]byte
					if _, err := rand.Read(b[:]); err != nil {
						return
					}
					xid = binary.BigEndian.Uint32(b[:]) | 1
					p.mu.Lock()
					p.renewXID = xid
					p.mu.Unlock()
				}
				_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if protocol.RenewDHCP(p.stream, p.mac, p.lease.Address.Addr(), p.lease.Server, xid) != nil {
					return
				}
			}
		}
	}
}
