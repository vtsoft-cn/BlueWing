package group

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	M "github.com/sagernet/sing/common/metadata"
	"github.com/sagernet/sing/service"
)

type adaptiveTestCA struct{ pool *x509.CertPool }

func (a adaptiveTestCA) Name() string                                   { return "test ca" }
func (a adaptiveTestCA) Start(adapter.StartStage, *adapter.Scope) error { return nil }
func (a adaptiveTestCA) Pool() *x509.CertPool                           { return a.pool }
func (a adaptiveTestCA) ExclusiveAnchors() bool                         { return true }

type adaptiveTestOutbound struct {
	outbound.Adapter
	address     string
	unreachable netip.Addr
}

func (a adaptiveTestOutbound) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	if a.unreachable.IsValid() && destination.Addr == a.unreachable {
		return nil, errors.New("fixture: address unreachable")
	}
	return (&net.Dialer{}).DialContext(ctx, network, a.address)
}

func (a adaptiveTestOutbound) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	panic("unexpected packet dial")
}

type adaptiveTestDNS struct {
	adapter.DNSRouter
	answer netip.Addr
}

func (d adaptiveTestDNS) Lookup(context.Context, string, adapter.DNSQueryOptions) ([]netip.Addr, error) {
	return []netip.Addr{d.answer}, nil
}

type adaptiveTestTransport struct{ adapter.DNSTransport }
type adaptiveTestTransports struct{ adapter.DNSTransportManager }

func (adaptiveTestTransports) Transport(string) (adapter.DNSTransport, bool) {
	return adaptiveTestTransport{}, true
}

func TestAdaptivePublicRejectsNonPublicTargets(t *testing.T) {
	for _, name := range []string{"nas", "vpn.corp.local", "service.internal", "hidden.onion", "169.254.169.254", "host/path.com"} {
		if eligiblePublicHost(name) {
			t.Errorf("ineligible host accepted: %s", name)
		}
	}
	for _, raw := range []string{"10.108.148.195", "::ffff:192.168.1.1", "100.64.1.1", "198.18.1.1", "fc00::1", "127.0.0.1", "169.254.169.254"} {
		if publicAnswers([]netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr(raw)}) {
			t.Errorf("public/private mixed answer accepted: %s", raw)
		}
	}
	if !eligiblePublicHost("github.com") || !publicAnswers([]netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("2606:4700::1111")}) {
		t.Fatal("public origin rejected")
	}
}

func TestAdaptivePublicChoosesVerifiedFasterPath(t *testing.T) {
	body := bytes.Repeat([]byte("x"), adaptiveSampleBytes)
	serve := func(delay time.Duration) *httptest.Server {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" || r.Header.Get("Authorization") != "" || len(r.Cookies()) != 0 {
				t.Error("probe forwarded request data")
			}
			select {
			case <-time.After(delay):
				_, _ = w.Write(body)
			case <-r.Context().Done():
			}
		}))
		t.Cleanup(server.Close)
		return server
	}
	direct, slow, fast := serve(0), serve(6*time.Second), serve(0)
	pool := x509.NewCertPool()
	pool.AddCert(direct.Certificate())
	ctx := service.ContextWith[adapter.CertificateStore](t.Context(), adaptiveTestCA{pool: pool})
	a := &AdaptivePublic{ctx: ctx, direct: &adaptiveTestOutbound{address: direct.Listener.Addr().String()}}
	host := "example.com" // The standard-library fixture certificate covers this name.
	address := netip.MustParseAddr("1.1.1.1")
	measure := func(proxy *httptest.Server) netip.Addr {
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return a.comparePublic(probeCtx, host, []netip.Addr{address}, &adaptiveTestOutbound{address: proxy.Listener.Addr().String()})
	}
	if got := measure(slow); got != address {
		t.Fatalf("slow proxy did not switch to the verified address: %v", got)
	}
	a.direct = &adaptiveTestOutbound{address: slow.Listener.Addr().String()}
	if got := measure(fast); got.IsValid() {
		t.Fatalf("healthy proxy switched unnecessarily: %v", got)
	}
	a.direct = &adaptiveTestOutbound{address: direct.Listener.Addr().String()}
	probeCtx, cancel := context.WithTimeout(ctx, adaptiveProbeTimeout)
	defer cancel()
	if got := a.sample(probeCtx, "wrong.invalid", M.Socksaddr{Addr: address, Port: 443}, a.direct, time.Now()); got.bytes != 0 {
		t.Fatal("TLS name mismatch was treated as a healthy route")
	}
	alternate := netip.MustParseAddr("8.8.8.8")
	a.direct = &adaptiveTestOutbound{address: direct.Listener.Addr().String(), unreachable: address}
	a.dns = adaptiveTestDNS{answer: alternate}
	a.dnsTags = adaptiveTestTransports{}
	if got := measure(slow); got != alternate {
		t.Fatalf("working DNS alternative did not recover the broken system address: %v", got)
	}
}
