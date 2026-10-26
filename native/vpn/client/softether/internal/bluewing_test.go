package softether

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"net/netip"
	"testing"
)

func TestDHCPClasslessRoutesNeverIncludeDefault(t *testing.T) {
	routes := classlessRoutes([]byte{0, 10, 0, 0, 1, 24, 192, 168, 110, 10, 0, 0, 1})
	if len(routes) != 1 || routes[0].String() != "192.168.110.0/24" {
		t.Fatal(routes)
	}
	for _, bad := range [][]byte{{33}, {24, 10}, {24, 10, 20, 30}} {
		if classlessRoutes(bad) != nil {
			t.Fatal("malformed DHCP route accepted")
		}
	}
}
func TestDHCPRenewalMatching(t *testing.T) {
	mac := [6]byte{2, 0, 0, 0, 0, 1}
	server := netip.MustParseAddr("10.0.0.1")
	ip := netip.MustParseAddr("10.0.0.2")
	frame := buildDHCPServer(dhcpACK, 55, mac, [6]byte{2, 0, 0, 0, 0, 2}, server, ip, 24, []netip.Addr{server})
	lease, ok, err := RenewalReply(frame, mac, 55)
	if !ok || err != nil || lease.Lifetime.Seconds() != 3600 || lease.Address.Addr() != ip {
		t.Fatal("renewal not accepted")
	}
	_, ok, _ = RenewalReply(frame, mac, 56)
	if ok {
		t.Fatal("stale renewal accepted")
	}
}
func TestPackRejectsHugeAllocationFromSmallInput(t *testing.T) {
	var body bytes.Buffer
	writeUint32(&body, 1)
	writeUint32(&body, 2)
	body.WriteByte('x')
	writeUint32(&body, TypeData)
	writeUint32(&body, 1)
	writeUint32(&body, 96*1024*1024)
	if _, err := UnmarshalPack(body.Bytes()); err == nil {
		t.Fatal("oversized PACK value accepted")
	}
	var wire bytes.Buffer
	binary.Write(&wire, binary.BigEndian, uint32(1))
	binary.Write(&wire, binary.BigEndian, uint32(MaxEthernetFrame+1))
	wire.Write(make([]byte, MaxEthernetFrame+1))
	if _, err := NewFrameStream(&wire, &wire).ReadFrames(); err == nil {
		t.Fatal("oversized Ethernet frame accepted")
	}
}

func TestHTTPHeaderIsBounded(t *testing.T) {
	wire := append([]byte("HTTP/1.1 200 OK\r\nX: "), bytes.Repeat([]byte{'a'}, 32*1024)...)
	if _, err := ReadPackResponse(bufio.NewReader(bytes.NewReader(wire))); err == nil {
		t.Fatal("unbounded header accepted")
	}
}
