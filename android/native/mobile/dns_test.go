package mobile

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestSplitDNSKeepsCompanyQueriesOffPublicResolvers(t *testing.T) {
	suffixes, err := parseDNSSuffixes("Corp.Example, lab.example.")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		want []string
	}{
		{"corp.example.", []string{"company 10.20.0.53:53"}},
		{"GIT.CORP.EXAMPLE.", []string{"company 10.20.0.53:53"}},
		{"notcorp.example.", []string{"public [2001:db8::53]:53"}},
		{"corp.example.net.", []string{"public [2001:db8::53]:53"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			record := func(path string) dnsDial {
				return func(_ context.Context, _, address string) (net.Conn, error) {
					calls = append(calls, path+" "+address)
					return nil, errors.New("resolver unreachable")
				}
			}
			resolver := splitDNS{
				suffixes: suffixes, companyServers: []string{"10.20.0.53"},
				publicServers: []string{"2001:db8::53"},
				companyDial:   record("company"), publicDial: record("public"),
			}
			if _, err := resolver.resolve(context.Background(), new(dns.Msg).SetQuestion(tc.name, dns.TypeAAAA)); err == nil {
				t.Fatal("expected DNS failure")
			}
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("dialed %v, want %v", calls, tc.want)
			}
		})
	}
}

func TestSplitDNSRetriesTruncationOnSameCompanyPath(t *testing.T) {
	var networks []string
	resolver := splitDNS{
		suffixes: []string{"corp.example."}, companyServers: []string{"10.20.0.53"},
		companyDial: func(_ context.Context, network, _ string) (net.Conn, error) {
			networks = append(networks, network)
			client, server := net.Pipe()
			var clientConn, serverConn net.Conn = client, server
			if network == "udp" {
				clientConn, serverConn = packetPipe{client}, packetPipe{server}
			}
			go func() {
				defer server.Close()
				dnsConn := &dns.Conn{Conn: serverConn}
				request, err := dnsConn.ReadMsg()
				if err != nil {
					return
				}
				response := new(dns.Msg).SetReply(request)
				response.Truncated = network == "udp"
				if !response.Truncated {
					response.Answer = []dns.RR{&dns.A{
						Hdr: dns.RR_Header{Name: request.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 30},
						A:   net.IPv4(10, 20, 0, 10),
					}}
				}
				_ = dnsConn.WriteMsg(response)
			}()
			return clientConn, nil
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	answer, err := resolver.resolve(ctx, new(dns.Msg).SetQuestion("git.corp.example.", dns.TypeA))
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Answer) != 1 || answer.Answer[0].(*dns.A).A.String() != "10.20.0.10" {
		t.Fatalf("unexpected DNS answer: %v", answer)
	}
	if !reflect.DeepEqual(networks, []string{"udp", "tcp"}) {
		t.Fatalf("used DNS transports %v", networks)
	}
}

type packetPipe struct{ net.Conn }

func (p packetPipe) ReadFrom(buf []byte) (int, net.Addr, error) {
	n, err := p.Read(buf)
	return n, p.RemoteAddr(), err
}

func (p packetPipe) WriteTo(buf []byte, _ net.Addr) (int, error) {
	return p.Write(buf)
}
