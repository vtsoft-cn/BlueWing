package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/mythologyli/zju-connect/client"
	"github.com/mythologyli/zju-connect/stack/gvisor"
)

type auditDNSWriter struct{ msg *dns.Msg }

func (*auditDNSWriter) LocalAddr() net.Addr         { return &net.UDPAddr{} }
func (*auditDNSWriter) RemoteAddr() net.Addr        { return &net.UDPAddr{} }
func (w *auditDNSWriter) WriteMsg(m *dns.Msg) error { w.msg = m.Copy(); return nil }
func (*auditDNSWriter) Write(b []byte) (int, error) { return len(b), nil }
func (*auditDNSWriter) Close() error                { return nil }
func (*auditDNSWriter) TsigStatus() error           { return nil }
func (*auditDNSWriter) TsigTimersOnly(bool)         {}
func (*auditDNSWriter) Hijack()                     {}

type auditPipe struct {
	in, out chan []byte
	done    chan struct{}
	once    sync.Once
}

func TestTruncatedCompanyDNSRetriesTCPWithTheSameQuestion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request := new(dns.Msg)
	request.SetQuestion("service.corp.example.", dns.TypeTXT)
	var networks []string
	answer, err := exchangeDNSQuestion(ctx, request, func(ctx context.Context, network string) (net.Conn, error) {
		networks = append(networks, network)
		local, remote := net.Pipe()
		go func() {
			defer remote.Close()
			conn := &dns.Conn{Conn: remote}
			q, e := conn.ReadMsg()
			if e != nil {
				return
			}
			reply := new(dns.Msg)
			reply.SetReply(q)
			if network == "udp" {
				reply.Truncated = true
			} else {
				reply.Answer = []dns.RR{&dns.TXT{Hdr: dns.RR_Header{Name: q.Question[0].Name, Rrtype: dns.TypeTXT, Class: dns.ClassINET, Ttl: 60}, Txt: []string{"complete-company-record"}}}
			}
			_ = conn.WriteMsg(reply)
		}()
		return local, nil
	})
	if err != nil || answer == nil || answer.Truncated || len(answer.Answer) != 1 {
		t.Fatalf("TCP DNS fallback failed: %v %+v", err, answer)
	}
	if len(networks) != 2 || networks[0] != "udp" || networks[1] != "tcp" {
		t.Fatal("DNS transport fallback order changed", networks)
	}
}

func (p *auditPipe) Read(b []byte) (int, error) {
	select {
	case packet := <-p.in:
		return copy(b, packet), nil
	case <-p.done:
		return 0, io.EOF
	}
}
func (p *auditPipe) Write(b []byte) (int, error) {
	select {
	case p.out <- append([]byte(nil), b...):
		return len(b), nil
	case <-p.done:
		return 0, io.ErrClosedPipe
	}
}
func (p *auditPipe) Close() error { p.once.Do(func() { close(p.done) }); return nil }

type auditClient struct {
	client.Client
	pipe *auditPipe
}

func (*auditClient) IP() (net.IP, error)                      { return net.IPv4(192, 168, 30, 99), nil }
func (c *auditClient) NewL3Conn() (io.ReadWriteCloser, error) { return c.pipe, nil }

func TestCompanyDNSRecordTypes(t *testing.T) {
	pipe := &auditPipe{in: make(chan []byte, 8), out: make(chan []byte, 8), done: make(chan struct{})}
	stack, err := gvisor.NewStack(&auditClient{pipe: pipe})
	if err != nil {
		t.Fatal(err)
	}
	if err = stack.Prepare(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); stack.Close() })
	go func() { defer func() { _ = recover() }(); stack.Run() }()
	go func() {
		for {
			select {
			case packet := <-pipe.out:
				if len(packet) < 28 || packet[9] != 17 {
					continue
				}
				request := new(dns.Msg)
				if request.Unpack(packet[28:]) != nil {
					continue
				}
				response := new(dns.Msg)
				response.SetReply(request)
				h := dns.RR_Header{Name: request.Question[0].Name, Rrtype: request.Question[0].Qtype, Class: dns.ClassINET, Ttl: 60}
				switch request.Question[0].Qtype {
				case dns.TypeA:
					response.Answer = []dns.RR{&dns.A{Hdr: h, A: net.IPv4(10, 33, 0, 8)}}
				case dns.TypeSRV:
					response.Answer = []dns.RR{&dns.SRV{Hdr: h, Port: 389, Target: "dc.corp.example."}}
				case dns.TypeTXT:
					response.Answer = []dns.RR{&dns.TXT{Hdr: h, Txt: []string{"fixture-company-record"}}}
				}
				payload, _ := response.Pack()
				reply := make([]byte, 28+len(payload))
				reply[0] = 0x45
				binary.BigEndian.PutUint16(reply[2:4], uint16(len(reply)))
				reply[8] = 64
				reply[9] = 17
				copy(reply[12:16], packet[16:20])
				copy(reply[16:20], packet[12:16])
				copy(reply[20:22], packet[22:24])
				copy(reply[22:24], packet[20:22])
				binary.BigEndian.PutUint16(reply[24:26], uint16(8+len(payload)))
				copy(reply[28:], payload)
				binary.BigEndian.PutUint16(reply[10:12], probeChecksum(reply[:20]))
				select {
				case pipe.in <- reply:
				case <-pipe.done:
					return
				}
			case <-pipe.done:
				return
			}
		}
	}()
	s := &session{ctx: ctx, p: profile{ID: "fixture", Targets: []target{{Domains: []string{"corp.example"}}}}, resources: resources{DNSServers: []string{"10.203.19.1"}}, stack: stack, leases: make(map[string]dnsLease)}
	c := &controller{active: s}
	for _, kind := range []uint16{dns.TypeA, dns.TypeSRV, dns.TypeTXT} {
		t.Run(dns.TypeToString[kind], func(t *testing.T) {
			request := new(dns.Msg)
			request.SetQuestion("service.corp.example.", kind)
			writer := new(auditDNSWriter)
			c.answerDNS("fixture", writer, request)
			if writer.msg == nil {
				t.Fatal("no DNS response")
			}
			t.Logf("record=%s rcode=%d answerCount=%d", dns.TypeToString[kind], writer.msg.Rcode, len(writer.msg.Answer))
			if writer.msg.Rcode != dns.RcodeSuccess || len(writer.msg.Answer) != 1 {
				t.Fatal("a record available on the company DNS server was replaced by an empty result")
			}
		})
	}
}

func TestUDPOnlyResourceFragments(t *testing.T) {
	s := &session{p: profile{Protocol: "softether", TrafficMode: "split", Targets: []target{{CIDRs: []string{"10.88.0.0/16"}, Network: "udp"}}}}
	first, second := make([]byte, 44), make([]byte, 28)
	for _, packet := range [][]byte{first, second} {
		packet[0] = 0x45
		binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
		binary.BigEndian.PutUint16(packet[4:6], 0xb10)
		packet[8] = 64
		packet[9] = 17
		copy(packet[12:16], net.IPv4(172, 19, 0, 1).To4())
		copy(packet[16:20], net.IPv4(10, 88, 0, 53).To4())
	}
	binary.BigEndian.PutUint16(first[6:8], 0x2000)
	binary.BigEndian.PutUint16(first[20:22], 45000)
	binary.BigEndian.PutUint16(first[22:24], 53)
	binary.BigEndian.PutUint16(first[24:26], 32)
	binary.BigEndian.PutUint16(second[6:8], 3)
	a, b := s.allowedPacket(first), s.allowedPacket(second)
	t.Logf("UDP-only resource: firstFragment=%v continuation=%v", a, b)
	if !a || !b {
		t.Fatal("a fully authorized UDP datagram lost its continuation fragment")
	}
}
