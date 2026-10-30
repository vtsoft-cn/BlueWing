package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

func probeChecksum(b []byte) uint16 {
	var sum uint32
	for len(b) > 1 {
		sum += uint32(binary.BigEndian.Uint16(b))
		b = b[2:]
	}
	if len(b) > 0 {
		sum += uint32(b[0]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 65535) + (sum >> 16)
	}
	return ^uint16(sum)
}

// Explicit opt-in only: the normal test suite never contacts a real gateway.
func TestRealPacketRoundTrip(t *testing.T) {
	value := os.Getenv("BLUEWING_PACKET_PROBE")
	if value == "" {
		t.Skip("real gateway probe not requested")
	}
	var cfg struct {
		PrivateKey, ServerPublicKey, Target string
		Port                                int
	}
	if err := json.Unmarshal([]byte(value), &cfg); err != nil {
		t.Fatal(err)
	}
	key, _ := base64.StdEncoding.DecodeString(cfg.PrivateKey)
	peer, _ := base64.StdEncoding.DecodeString(cfg.ServerPublicKey)
	responses := make(chan []byte, 16)
	adapter := &packetTUN{queue: make(chan []byte, 128), done: make(chan struct{}), events: make(chan tun.Event, 1), inject: func(b []byte) { responses <- append([]byte(nil), b...) }}
	d := device.NewDevice(adapter, &loopbackBind{}, &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	t.Cleanup(d.Close)
	if err := d.IpcSet(fmt.Sprintf("private_key=%s\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=0.0.0.0/0\n", hex.EncodeToString(key), hex.EncodeToString(peer), cfg.Port)); err != nil {
		t.Fatal(err)
	}
	if err := d.Up(); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 48)
	b[0] = 0x45
	b[3] = byte(len(b))
	b[8] = 64
	b[9] = 1
	copy(b[12:], net.IPv4(100, 126, 255, 2).To4())
	copy(b[16:], net.ParseIP(cfg.Target).To4())
	b[20] = 8
	binary.BigEndian.PutUint16(b[24:], 0xb10)
	binary.BigEndian.PutUint16(b[26:], 1)
	copy(b[28:], []byte("bluewing-first-packet"))
	binary.BigEndian.PutUint16(b[22:], probeChecksum(b[20:]))
	binary.BigEndian.PutUint16(b[10:], probeChecksum(b[:20]))
	start := time.Now()
	adapter.queue <- b
	select {
	case reply := <-responses:
		if len(reply) < 28 || reply[9] != 1 || reply[20] != 0 || binary.BigEndian.Uint16(reply[24:]) != 0xb10 {
			t.Fatalf("unexpected ICMP response: %x", reply)
		}
		t.Logf("first ICMP echo reply from %s after %s", net.IP(reply[12:16]), time.Since(start))
	case <-time.After(12 * time.Second):
		t.Fatal("first ICMP echo did not return")
	}
	// A new UDP flow must also return its first datagram through the complete
	// sing-box -> authenticated packet link -> provider -> reverse NAT chain.
	dns := []byte{0xb1, 0x01, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9, 'l', 'o', 'c', 'a', 'l', 'h', 'o', 's', 't', 0, 0, 1, 0, 1}
	u := make([]byte, 28+len(dns))
	u[0] = 0x45
	binary.BigEndian.PutUint16(u[2:], uint16(len(u)))
	u[8] = 64
	u[9] = 17
	copy(u[12:], net.IPv4(100, 126, 255, 2).To4())
	copy(u[16:], net.IPv4(192, 168, 30, 1).To4())
	binary.BigEndian.PutUint16(u[20:], 45000)
	binary.BigEndian.PutUint16(u[22:], 53)
	binary.BigEndian.PutUint16(u[24:], uint16(len(u)-20))
	copy(u[28:], dns)
	binary.BigEndian.PutUint16(u[10:], probeChecksum(u[:20]))
	adapter.queue <- u
	select {
	case reply := <-responses:
		if len(reply) < 40 || reply[9] != 17 || binary.BigEndian.Uint16(reply[22:]) != 45000 || binary.BigEndian.Uint16(reply[28:]) != 0xb101 {
			t.Fatalf("unexpected UDP response: %x", reply)
		}
		t.Logf("first UDP DNS response returned from %s", net.IP(reply[12:16]))
	case <-time.After(10 * time.Second):
		t.Fatal("first UDP datagram did not return")
	}
}

func TestAuthenticatedPacketLinkDeliversFirstQueuedPacket(t *testing.T) {
	clientKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan []byte, 1)
	server, err := newPacketEndpoint(base64.StdEncoding.EncodeToString(clientKey.PublicKey().Bytes()), func(b []byte) { got <- append([]byte(nil), b...) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.device.Close)
	replies := make(chan []byte, 1)
	clientTUN := &packetTUN{queue: make(chan []byte, 128), done: make(chan struct{}), events: make(chan tun.Event, 1), inject: func(b []byte) { replies <- append([]byte(nil), b...) }}
	client := device.NewDevice(clientTUN, &loopbackBind{}, &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	t.Cleanup(client.Close)
	public, _ := base64.StdEncoding.DecodeString(server.publicKey)
	if err = client.IpcSet(fmt.Sprintf("private_key=%s\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=0.0.0.0/0\n", hex.EncodeToString(clientKey.Bytes()), hex.EncodeToString(public), server.port)); err != nil {
		t.Fatal(err)
	}
	if err = client.Up(); err != nil {
		t.Fatal(err)
	}
	packet := make([]byte, 28)
	packet[0] = 0x45
	packet[3] = 28
	packet[8] = 64
	packet[9] = 1
	copy(packet[12:], net.IPv4(172, 19, 0, 1).To4())
	copy(packet[16:], net.IPv4(192, 168, 110, 45).To4())
	packet[20] = 8
	clientTUN.queue <- packet
	select {
	case b := <-got:
		if len(b) < 28 || !net.IP(b[16:20]).Equal(net.IPv4(192, 168, 110, 45)) {
			t.Fatal("first packet changed")
		}
		server.send(b)
	case <-time.After(3 * time.Second):
		t.Fatal("first packet lost during WireGuard handshake")
	}
	select {
	case <-replies:
	case <-time.After(time.Second):
		t.Fatal("return path failed")
	}
}

func TestPacketAuthorizationCoversPrivateICMPAndUDPWithoutLearning(t *testing.T) {
	s := &session{p: profile{Protocol: "softether", TrafficMode: "split", AutoDiscoverPrivate: true}, privateRoutes: &privateRoutePicker{}}
	for _, proto := range []byte{1, 17} {
		b := make([]byte, 32)
		b[0] = 0x45
		b[3] = 32
		b[9] = proto
		copy(b[16:], net.IPv4(192, 168, 110, 45).To4())
		b[22] = 0x27
		b[23] = 0x0f
		if !s.allowedPacket(b) {
			t.Fatal("first private packet denied", proto)
		}
		copy(b[16:], net.IPv4(1, 1, 1, 1).To4())
		if s.allowedPacket(b) {
			t.Fatal("split packet scope widened to public traffic")
		}
		copy(b[16:], net.IPv4(192, 168, 110, 45).To4())
		s.p.Targets = []target{{CIDRs: []string{"192.168.110.0/24"}, Ports: []string{"22"}, Network: "tcp"}}
		if s.allowedPacket(b) {
			t.Fatal("explicit company restriction bypassed")
		}
		s.p.Targets = nil
	}
}
