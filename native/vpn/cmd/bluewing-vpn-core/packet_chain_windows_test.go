package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/mythologyli/zju-connect/stack/gvisor"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

type packetChainLog struct {
	mu    sync.Mutex
	data  bytes.Buffer
	ready chan struct{}
	once  sync.Once
}

func (l *packetChainLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n, err := l.data.Write(p)
	if strings.Contains(l.data.String(), "sing-box started") {
		l.once.Do(func() { close(l.ready) })
	}
	return n, err
}
func (l *packetChainLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.data.String() }

func packetChainPair(t *testing.T) (string, string) {
	t.Helper()
	k, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	return base64.StdEncoding.EncodeToString(k.Bytes()), base64.StdEncoding.EncodeToString(k.PublicKey().Bytes())
}
func packetChainSplit(packet []byte) [][]byte {
	var out [][]byte
	for offset := 0; offset < len(packet)-20; {
		n := min(1248, len(packet)-20-offset)
		p := make([]byte, 20+n)
		copy(p, packet[:20])
		copy(p[20:], packet[20+offset:20+offset+n])
		binary.BigEndian.PutUint16(p[2:], uint16(len(p)))
		flags := uint16(offset / 8)
		if offset+n < len(packet)-20 {
			flags |= 0x2000
		}
		binary.BigEndian.PutUint16(p[6:], flags)
		p[10], p[11] = 0, 0
		binary.BigEndian.PutUint16(p[10:], probeChecksum(p[:20]))
		out = append(out, p)
		offset += n
	}
	return out
}
func packetChainDatagram(proto byte, size int, ident uint16) []byte {
	p := make([]byte, size)
	p[0] = 0x45
	binary.BigEndian.PutUint16(p[2:], uint16(len(p)))
	binary.BigEndian.PutUint16(p[4:], ident)
	p[8] = 64
	p[9] = proto
	copy(p[12:], net.IPv4(100, 126, 255, 2).To4())
	copy(p[16:], net.IPv4(10, 203, 17, 45).To4())
	for i := 28; i < len(p); i++ {
		p[i] = byte(i) ^ byte(ident)
	}
	if proto == 1 {
		p[20] = 8
		binary.BigEndian.PutUint16(p[24:], ident)
		binary.BigEndian.PutUint16(p[22:], probeChecksum(p[20:]))
	} else {
		binary.BigEndian.PutUint16(p[20:], 45000+ident%16)
		binary.BigEndian.PutUint16(p[22:], 33443)
		binary.BigEndian.PutUint16(p[24:], uint16(len(p)-20))
	}
	p[10], p[11] = 0, 0
	binary.BigEndian.PutUint16(p[10:], probeChecksum(p[:20]))
	return p
}

func TestPacketChainIPv4RoundTrips(t *testing.T) {
	normalPrivate, normalPublic := packetChainPair(t)
	icmpPrivate, icmpPublic := packetChainPair(t)
	frontPrivate, frontPublic := packetChainPair(t)
	clientPrivate, clientPublic := packetChainPair(t)
	pipe := &auditPipe{in: make(chan []byte, 128), out: make(chan []byte, 128), done: make(chan struct{})}
	st, err := gvisor.NewStack(&auditClient{pipe: pipe})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err = st.Prepare(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &session{ctx: ctx, stack: st, p: profile{Protocol: "softether", TrafficMode: "split", AutoDiscoverPrivate: true}, privateRoutes: &privateRoutePicker{}}
	var forwarded, rawIngress atomic.Int32
	var providerFragments, providerDatagrams atomic.Int32
	metadata := make(chan string, 64)
	var fragmentMu sync.Mutex
	fragmentIDs := make(map[uint16]bool)
	fragmentError := make(chan string, 1)
	inject := func(b []byte) {
		rawIngress.Add(1)
		if len(b) >= 28 && b[9] == 17 && binary.BigEndian.Uint16(b[6:])&0x3fff == 0x2000 {
			id := binary.BigEndian.Uint16(b[4:])
			fragmentMu.Lock()
			if id == 0 || fragmentIDs[id] {
				select {
				case fragmentError <- "fragmented UDP reused a zero/active IPv4 ID":
				default:
				}
			}
			fragmentIDs[id] = true
			fragmentMu.Unlock()
		}
		if len(b) >= 20 {
			select {
			case metadata <- fmt.Sprintf("raw length=%d total=%d id=%d flags=%04x checksum=%04x protocol=%d", len(b), binary.BigEndian.Uint16(b[2:]), binary.BigEndian.Uint16(b[4:]), binary.BigEndian.Uint16(b[6:]), probeChecksum(b[:int(b[0]&15)*4]), b[9]):
			default:
			}
		}
		if p := s.preparePacket(b); p != nil {
			forwarded.Add(1)
			_ = st.InjectPacket(p)
		}
	}
	normal, err := newPacketEndpoint(normalPublic, inject)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(normal.device.Close)
	icmp, err := newPacketEndpoint(icmpPublic, inject)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(icmp.device.Close)
	if err = st.EnablePackets((&endpoint{packet: normal, icmpPacket: icmp}).returnPackets()); err != nil {
		t.Fatal(err)
	}
	go func() { defer func() { recover() }(); st.Run() }()
	go func() {
		var assembly packetFragments
		for {
			select {
			case <-pipe.done:
				return
			case p := <-pipe.out:
				providerFragments.Add(1)
				b := assembly.Accept(p, time.Now())
				if b == nil {
					continue
				}
				providerDatagrams.Add(1)
				reply := append([]byte(nil), b...)
				copy(reply[12:16], b[16:20])
				copy(reply[16:20], b[12:16])
				if b[9] == 1 {
					reply[20] = 0
					reply[22], reply[23] = 0, 0
					binary.BigEndian.PutUint16(reply[22:], probeChecksum(reply[20:]))
				} else {
					copy(reply[20:22], b[22:24])
					copy(reply[22:24], b[20:22])
					reply[26], reply[27] = 0, 0
				}
				for _, part := range packetChainSplit(reply) {
					select {
					case pipe.in <- part:
					case <-pipe.done:
						return
					}
				}
			}
		}
	}()
	var loopback string
	ifs, _ := net.Interfaces()
	for _, iface := range ifs {
		if iface.Flags&net.FlagLoopback != 0 {
			loopback = iface.Name
			break
		}
	}
	udp, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	frontPort := udp.LocalAddr().(*net.UDPAddr).Port
	udp.Close()
	endpoint := func(tag, key, address, pub string, port int) map[string]any {
		return map[string]any{"type": "wireguard", "tag": tag, "system": false, "mtu": 1280, "bind_interface": loopback, "inet4_bind_address": "127.0.0.1", "address": []string{address}, "private_key": key, "peers": []any{map[string]any{"address": "127.0.0.1", "port": port, "public_key": pub, "allowed_ips": []string{"0.0.0.0/0"}}}}
	}
	front := map[string]any{"type": "wireguard", "tag": "test-in", "system": false, "mtu": 1280, "bind_interface": loopback, "inet4_bind_address": "127.0.0.1", "address": []string{"100.126.255.1/32"}, "private_key": frontPrivate, "listen_port": frontPort, "peers": []any{map[string]any{"public_key": clientPublic, "allowed_ips": []string{"0.0.0.0/0"}}}}
	cfg := map[string]any{"log": map[string]any{"level": "info"}, "endpoints": []any{endpoint("udp-out", normalPrivate, "100.127.255.1/32", normal.publicKey, normal.port), endpoint("icmp-out", icmpPrivate, "0.0.0.0/32", icmp.publicKey, icmp.port), front}, "outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}}, "route": map[string]any{"rules": []any{map[string]any{"network": []string{"udp"}, "outbound": "udp-out"}, map[string]any{"network": []string{"icmp"}, "outbound": "icmp-out"}}, "final": "direct"}}
	file := filepath.Join(t.TempDir(), "config.json")
	data, _ := json.Marshal(cfg)
	if e = os.WriteFile(file, data, 0600); e != nil {
		t.Fatal(e)
	}
	binaryPath, _ := filepath.Abs(filepath.Join("..", "..", "..", "..", "bin", "sing-box.exe"))
	logs := packetChainLog{ready: make(chan struct{})}
	cmd := exec.Command(binaryPath, "run", "-c", file)
	cmd.Stdout = &logs
	cmd.Stderr = &logs
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	responses := make(chan []byte, 128)
	adapter := &packetTUN{queue: make(chan []byte, 128), done: make(chan struct{}), events: make(chan tun.Event, 1), inject: func(b []byte) { responses <- append([]byte(nil), b...) }}
	d := device.NewDevice(adapter, &loopbackBind{}, &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	t.Cleanup(d.Close)
	key, _ := base64.StdEncoding.DecodeString(clientPrivate)
	peer, _ := base64.StdEncoding.DecodeString(frontPublic)
	if e = d.IpcSet("private_key=" + hex.EncodeToString(key) + "\npublic_key=" + hex.EncodeToString(peer) + "\nendpoint=127.0.0.1:" + strconv.Itoa(frontPort) + "\nallowed_ip=0.0.0.0/0\n"); e != nil {
		t.Fatal(e)
	}
	if e = d.Up(); e != nil {
		t.Fatal(e)
	}
	select {
	case <-logs.ready:
	case <-time.After(10 * time.Second):
		t.Fatalf("routing core did not become ready: %s", logs.String())
	}
	for _, tc := range []struct {
		name  string
		proto byte
		size  int
		ident uint16
		whole bool
	}{{"real-small-icmp", 1, 48, 0xc10, false}, {"small-udp", 17, 64, 0xc09, false}, {"whole-1500-udp", 17, 1500, 0xc07, true}, {"fragmented-1500-udp", 17, 1500, 0xc08, false}, {"large-udp-both-directions", 17, 3072, 0xc11, false}, {"large-icmp", 1, 2048, 0xc12, false}, {"8192-byte-icmp", 1, 8192, 0xc13, false}} {
		t.Run(tc.name, func(t *testing.T) {
			before := forwarded.Load()
			p := packetChainDatagram(tc.proto, tc.size, tc.ident)
			parts := packetChainSplit(p)
			if tc.whole {
				parts = [][]byte{p}
			}
			for _, part := range parts {
				adapter.queue <- part
			}
			var assembly packetFragments
			deadline := time.After(3 * time.Second)
			for {
				select {
				case raw := <-responses:
					reply := assembly.Accept(raw, time.Now())
					if reply == nil {
						continue
					}
					if len(reply) != len(p) || reply[9] != tc.proto || !bytes.Equal(reply[28:], p[28:]) {
						t.Fatalf("unexpected reply length/protocol/payload: length=%d protocol=%d", len(reply), reply[9])
					}
					if tc.proto == 1 && (reply[20] != 0 || binary.BigEndian.Uint16(reply[24:]) != tc.ident) {
						t.Fatal("wrong ICMP reply")
					}
					if forwarded.Load() <= before {
						t.Fatal("synthetic local reply did not traverse the native peer")
					}
					t.Logf("returned %d bytes through sing-box, authenticated peer, provider NAT and reverse path", len(reply))
					return
				case <-deadline:
					t.Logf("rawIngress=%d injected=%d providerFragments=%d providerDatagrams=%d", rawIngress.Load(), forwarded.Load(), providerFragments.Load(), providerDatagrams.Load())
					for len(metadata) > 0 {
						t.Log(<-metadata)
					}
					t.Fatal("no real reply through the packet chain")
					return
				}
			}
		})
	}
	t.Run("concurrent-large-udp", func(t *testing.T) {
		expected := make(map[uint16][]byte)
		for i := 0; i < 8; i++ {
			p := packetChainDatagram(17, 3072, uint16(0xd00+i))
			expected[binary.BigEndian.Uint16(p[20:])] = p
			// Deliberately interleave input fragments from the same IP pair.
		}
		groups := make([][][]byte, 0, 8)
		for _, p := range expected {
			groups = append(groups, packetChainSplit(p))
		}
		for part := 0; part < len(groups[0]); part++ {
			for _, parts := range groups {
				adapter.queue <- parts[part]
			}
		}
		var assembly packetFragments
		deadline := time.After(5 * time.Second)
		for len(expected) > 0 {
			select {
			case raw := <-responses:
				reply := assembly.Accept(raw, time.Now())
				if reply == nil {
					continue
				}
				if len(reply) < 28 || reply[9] != 17 {
					t.Fatal("unexpected concurrent reply")
				}
				port := binary.BigEndian.Uint16(reply[22:])
				p, ok := expected[port]
				if !ok || len(reply) != len(p) || !bytes.Equal(reply[28:], p[28:]) {
					t.Fatal("concurrent datagrams collided or payload mixed")
				}
				delete(expected, port)
			case <-deadline:
				t.Fatalf("missing concurrent replies: %d", len(expected))
			}
		}
	})
	select {
	case err := <-fragmentError:
		t.Fatal(err)
	default:
	}

}
