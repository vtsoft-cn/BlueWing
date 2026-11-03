package mobile

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

func TestDNSPacketUsesSelectedResolver(t *testing.T) {
	endpoint, err := newDNSEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	defer endpoint.close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	called := make(chan string, 1)
	endpoint.serve(ctx, splitDNS{
		suffixes: []string{"corp.example."}, companyServers: []string{"10.0.0.53"},
		publicServers: []string{"192.0.2.53"},
		companyDial: func(_ context.Context, _, address string) (net.Conn, error) {
			called <- address
			return nil, errors.New("fixture unavailable")
		},
		publicDial: func(_ context.Context, _, address string) (net.Conn, error) {
			called <- address
			return nil, errors.New("fixture unavailable")
		},
	})
	query := new(dns.Msg).SetQuestion("git.corp.example.", dns.TypeA)
	payload, err := query.Pack()
	if err != nil {
		t.Fatal(err)
	}
	packet := make([]byte, header.IPv4MinimumSize+header.UDPMinimumSize+len(payload))
	ip := header.IPv4(packet)
	ip.Encode(&header.IPv4Fields{
		TotalLength: uint16(len(packet)), TTL: 64, Protocol: uint8(header.UDPProtocolNumber),
		SrcAddr: tcpip.AddrFrom4([4]byte{10, 0, 0, 2}), DstAddr: tcpip.AddrFrom4([4]byte{198, 18, 0, 53}),
	})
	ip.SetChecksum(^ip.CalculateChecksum())
	udp := header.UDP(packet[header.IPv4MinimumSize:])
	udp.Encode(&header.UDPFields{SrcPort: 49152, DstPort: 53, Length: uint16(len(payload) + header.UDPMinimumSize)})
	copy(udp.Payload(), payload)
	endpoint.inject(packet)
	response := endpoint.link.ReadContext(ctx)
	if response == nil {
		t.Fatal("no DNS response packet")
	}
	defer response.DecRef()
	view := response.ToView()
	defer view.Release()
	answer := new(dns.Msg)
	if err := answer.Unpack(header.UDP(header.IPv4(view.AsSlice()).Payload()).Payload()); err != nil {
		t.Fatal(err)
	}
	if answer.Id != query.Id || answer.Rcode != dns.RcodeServerFailure {
		t.Fatalf("unexpected DNS response: %v", answer)
	}
	select {
	case address := <-called:
		if address != "10.0.0.53:53" {
			t.Fatalf("DNS query used %s", address)
		}
	default:
		t.Fatal("DNS query did not reach an upstream resolver")
	}
}
