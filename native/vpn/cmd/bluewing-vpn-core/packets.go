package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

// An authenticated, loopback-only IP link between sing-box and the provider.
// It uses an in-memory TUN; it creates no system adapter or persistent route.
type packetEndpoint struct {
	device    *device.Device
	tun       *packetTUN
	port      int
	publicKey string
}
type packetTUN struct {
	queue  chan []byte
	done   chan struct{}
	events chan tun.Event
	once   sync.Once
	inject func([]byte)
}

func (t *packetTUN) File() *os.File           { return nil }
func (t *packetTUN) Name() (string, error)    { return "bluewing-packet-link", nil }
func (t *packetTUN) MTU() (int, error)        { return 1400, nil }
func (t *packetTUN) BatchSize() int           { return 1 }
func (t *packetTUN) Events() <-chan tun.Event { return t.events }
func (t *packetTUN) Close() error             { t.once.Do(func() { close(t.done); close(t.events) }); return nil }
func (t *packetTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	select {
	case b := <-t.queue:
		if len(b) > len(bufs[0])-offset {
			return 0, io.ErrShortBuffer
		}
		sizes[0] = copy(bufs[0][offset:], b)
		return 1, nil
	case <-t.done:
		return 0, os.ErrClosed
	}
}
func (t *packetTUN) Write(bufs [][]byte, offset int) (int, error) {
	for _, b := range bufs {
		if offset <= len(b) {
			t.inject(b[offset:])
		}
	}
	return len(bufs), nil
}
func (p *packetEndpoint) send(b []byte) {
	select {
	case p.tun.queue <- append([]byte(nil), b...):
	case <-p.tun.done:
	default:
	}
}

type loopbackEndpoint struct{ address netip.AddrPort }

func (*loopbackEndpoint) ClearSrc()             {}
func (*loopbackEndpoint) SrcToString() string   { return "" }
func (e *loopbackEndpoint) DstToString() string { return e.address.String() }
func (e *loopbackEndpoint) DstIP() netip.Addr   { return e.address.Addr() }
func (*loopbackEndpoint) SrcIP() netip.Addr     { return netip.Addr{} }
func (e *loopbackEndpoint) DstToBytes() []byte {
	b := append([]byte(nil), e.address.Addr().AsSlice()...)
	return binary.BigEndian.AppendUint16(b, e.address.Port())
}

type loopbackBind struct {
	mu     sync.Mutex
	socket *net.UDPConn
	port   uint16
}

func (b *loopbackBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.socket != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	s, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(port)})
	if e != nil {
		return nil, 0, e
	}
	b.socket = s
	b.port = uint16(s.LocalAddr().(*net.UDPAddr).Port)
	receive := func(packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
		n, addr, e := s.ReadFromUDPAddrPort(packets[0])
		if e != nil {
			return 0, e
		}
		sizes[0] = n
		endpoints[0] = &loopbackEndpoint{addr}
		return 1, nil
	}
	return []conn.ReceiveFunc{receive}, b.port, nil
}
func (b *loopbackBind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.socket == nil {
		return nil
	}
	e := b.socket.Close()
	b.socket = nil
	return e
}
func (*loopbackBind) SetMark(uint32) error { return nil }
func (*loopbackBind) BatchSize() int       { return 1 }
func (*loopbackBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	a, e := netip.ParseAddrPort(s)
	if e != nil || !a.Addr().IsLoopback() {
		return nil, errors.New("packet peer must use loopback")
	}
	return &loopbackEndpoint{a}, nil
}
func (b *loopbackBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	b.mu.Lock()
	s := b.socket
	b.mu.Unlock()
	if s == nil {
		return net.ErrClosed
	}
	a, e := netip.ParseAddrPort(ep.DstToString())
	if e != nil || !a.Addr().IsLoopback() {
		return errors.New("invalid packet peer")
	}
	for _, buf := range bufs {
		if _, e = s.WriteToUDPAddrPort(buf, a); e != nil {
			return e
		}
	}
	return nil
}
func newPacketEndpoint(peer string, inject func([]byte)) (*packetEndpoint, error) {
	key, e := base64.StdEncoding.DecodeString(peer)
	if e != nil || len(key) != 32 {
		return nil, errors.New("invalid packet peer key")
	}
	private, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		return nil, e
	}
	t := &packetTUN{queue: make(chan []byte, 128), done: make(chan struct{}), events: make(chan tun.Event, 1), inject: inject}
	bind := &loopbackBind{}
	d := device.NewDevice(t, bind, &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	configuration := fmt.Sprintf("private_key=%s\nlisten_port=0\nreplace_peers=true\npublic_key=%s\nallowed_ip=0.0.0.0/0\n", hex.EncodeToString(private.Bytes()), hex.EncodeToString(key))
	if e = d.IpcSet(configuration); e != nil {
		d.Close()
		return nil, e
	}
	if e = d.Up(); e != nil {
		d.Close()
		return nil, e
	}
	return &packetEndpoint{device: d, tun: t, port: int(bind.port), publicKey: base64.StdEncoding.EncodeToString(private.PublicKey().Bytes())}, nil
}
func (s *session) allowedPacket(b []byte) bool {
	if len(b) < 20 || b[0]>>4 != 4 {
		return false
	}
	length := int(binary.BigEndian.Uint16(b[2:4]))
	header := int(b[0]&15) * 4
	if header < 20 || length < header || length > len(b) {
		return false
	}
	ip := netip.AddrFrom4([4]byte(b[16:20]))
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	port, network := 0, ""
	switch b[9] {
	case 1:
		network = "icmp"
	case 6:
		network = "tcp"
	case 17:
		network = "udp"
	default:
		return false
	}
	fragment := binary.BigEndian.Uint16(b[6:8])&0x1fff != 0
	if network != "icmp" && !fragment {
		if length < header+4 {
			return false
		}
		port = int(binary.BigEndian.Uint16(b[header+2 : header+4]))
	}
	if s.broadVPN() {
		return true
	}
	if network == "tcp" && !fragment {
		_, ok := s.classifyTCP(ip.String(), port)
		return ok
	}
	if network == "udp" && !fragment && s.allowed(ip.String(), port, network) {
		return true
	}
	// Full-network resources also authorize ICMP and IPv4 fragments. Port-only
	// company restrictions remain authoritative and cannot be bypassed here.
	for _, t := range append(append([]target{}, s.p.Targets...), s.resources.Targets...) {
		if t.GuardOnly || t.Network != "" {
			continue
		}
		full := len(t.Ports) == 0
		for _, p := range t.Ports {
			full = full || p == "1:65535"
		}
		if !full {
			continue
		}
		t.Ports = nil
		if targetMatch(t, ip.String(), 0, "", false) {
			return true
		}
	}
	return privateAddress(ip.String()) && !s.protectedHost(ip.String()) && s.automaticPrivate()
}

func (c *controller) packetEndpoints() []map[string]any {
	var result []map[string]any
	loopback := ""
	if interfaces, e := net.Interfaces(); e == nil {
		for _, iface := range interfaces {
			if iface.Flags&net.FlagLoopback != 0 && iface.Flags&net.FlagUp != 0 {
				loopback = iface.Name
				break
			}
		}
	}
	for id, ep := range c.endpoints {
		if ep.packet != nil {
			result = append(result, map[string]any{"profileId": id, "port": ep.packet.port, "publicKey": ep.packet.publicKey, "loopbackInterface": loopback})
		}
	}
	return result
}
