package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestOnlyExplicitVPNModesMayExpandCompanyScope(t *testing.T) {
	var p profile
	if err := json.Unmarshal([]byte(`{"routeChina":true,"trafficMode":"split","targets":[{"domains":["office.company.cn"],"cidrs":["10.20.0.0/16"]}]}`), &p); err != nil {
		t.Fatal(err)
	}
	s := &session{p: p}
	if !s.allowed("10.20.30.40", 22, "tcp") || !s.companyDomain("office.company.cn") {
		t.Fatal("company target not accepted")
	}
	if s.allowed("223.5.5.5", 80, "tcp") || s.companyDomain("chatgpt.com") {
		t.Fatal("smart mode expanded into public traffic")
	}
	s.p.TrafficMode = "vpn"
	if !s.allowed("223.5.5.5", 80, "tcp") || !s.companyDomain("www.baidu.com") {
		t.Fatal("explicit VPN mode not applied")
	}
	if s.allowed("223.5.5.5", 80, "udp") || s.allowed("2606:4700::1111", 443, "tcp") {
		t.Fatal("unsupported public transport accepted")
	}
	s.p.TrafficMode = "custom"
	s.p.CustomRouting.Domestic = "direct"
	s.p.CustomRouting.Foreign = "proxy"
	s.p.CustomRouting.LAN = "direct"
	if s.broadVPN() {
		t.Fatal("custom mode without a VPN outlet expanded scope")
	}
	s.p.CustomRouting.Domestic = "vpn"
	if !s.broadVPN() {
		t.Fatal("explicit custom VPN outlet was ignored")
	}
}

func TestRangeCIDRsDoesNotBroaden(t *testing.T) {
	first, last := netip.MustParseAddr("10.20.1.1"), netip.MustParseAddr("10.20.2.0")
	values, err := rangeCIDRs(first, last)
	if err != nil {
		t.Fatal(err)
	}
	for ip := netip.MustParseAddr("10.20.1.0"); ip.Compare(netip.MustParseAddr("10.20.2.1")) <= 0; ip = ip.Next() {
		covered := false
		for _, s := range values {
			if netip.MustParsePrefix(s).Contains(ip) {
				covered = true
			}
		}
		want := ip.Compare(first) >= 0 && ip.Compare(last) <= 0
		if covered != want {
			t.Fatalf("range widened/dropped address %s", ip)
		}
	}
	if _, err = rangeCIDRs(last, first); err == nil {
		t.Fatal("reversed range accepted")
	}
	if _, err = rangeCIDRs(netip.MustParseAddr("0.0.0.0"), netip.MustParseAddr("255.255.255.255")); err == nil {
		t.Fatal("default range disguised as two /1 routes accepted")
	}
}
func TestTargetAuthorizationPreservesPortsAndSuffixBoundary(t *testing.T) {
	value := target{Domains: []string{"corp.example"}, CIDRs: []string{"10.20.0.0/16"}, Ports: []string{"22", "80:90"}, Network: "tcp"}
	for _, host := range []string{"corp.example", "dev.corp.example", "10.20.1.1"} {
		if !targetMatch(value, host, 22, "tcp", false) {
			t.Fatal(host)
		}
	}
	for _, host := range []string{"evilcorp.example", "corp.example.attacker.example", "10.21.1.1"} {
		if targetMatch(value, host, 22, "tcp", false) {
			t.Fatal(host)
		}
	}
	if targetMatch(value, "dev.corp.example", 443, "tcp", false) || targetMatch(value, "dev.corp.example", 22, "udp", false) {
		t.Fatal("authorization expanded")
	}
	if !targetMatch(value, "dev.corp.example", 443, "udp", true) {
		t.Fatal("guard did not cover all ports/protocols")
	}
}

func TestUnsupportedProtocolProtectsDestinationWithoutGrantingTCP(t *testing.T) {
	values := resourceTarget([]string{"corp.example"}, nil, 0, 0, "icmp")
	if len(values) != 1 || !values[0].GuardOnly {
		t.Fatal("unsupported protocol lost its guard")
	}
	if targetMatch(values[0], "corp.example", 80, "tcp", false) {
		t.Fatal("unsupported protocol granted TCP")
	}
	if !targetMatch(values[0], "corp.example", 80, "tcp", true) {
		t.Fatal("unsupported resource escaped its guard")
	}
}
func fixture(t *testing.T) (*controller, *endpoint) {
	c := &controller{endpoints: map[string]*endpoint{}}
	cfg := endpointConfig{Profile: profile{ID: "fixture"}, User: "fixture-user", Password: "fixture-password"}
	if err := c.configure([]endpointConfig{cfg}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(); c.closeEndpoints() })
	return c, c.endpoints["fixture"]
}
func socks(t *testing.T, ep *endpoint, password string) net.Conn {
	conn, err := net.DialTimeout("tcp", ep.listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(time.Second))
	conn.Write([]byte{5, 1, 2})
	b := make([]byte, 2)
	if _, err = io.ReadFull(conn, b); err != nil || b[1] != 2 {
		t.Fatal("authentication negotiation", err)
	}
	request := append([]byte{1, byte(len(ep.config.User))}, []byte(ep.config.User)...)
	request = append(request, byte(len(password)))
	request = append(request, []byte(password)...)
	conn.Write(request)
	if _, err = io.ReadFull(conn, b); err != nil {
		t.Fatal(err)
	}
	if password == ep.config.Password && b[1] != 0 {
		t.Fatal("correct credentials rejected")
	}
	if password != ep.config.Password && b[1] == 0 {
		t.Fatal("wrong credentials accepted")
	}
	return conn
}
func TestSOCKSRequiresAuthenticationAndFailsClosedOffline(t *testing.T) {
	_, ep := fixture(t)
	socks(t, ep, "wrong")
	conn := socks(t, ep, ep.config.Password)
	conn.Write([]byte{5, 1, 0, 1, 10, 20, 30, 40, 0, 80})
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] == 0 {
		t.Fatal("offline company connection accepted")
	}
	conn = socks(t, ep, ep.config.Password)
	conn.Write([]byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0})
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != 7 {
		t.Fatal("UDP was not explicitly rejected")
	}
}
func TestProbeRequiresOwnedCredentialsAndCurrentSessionToken(t *testing.T) {
	c, ep := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	c.active = &session{ctx: ctx, cancel: cancel, p: profile{ID: "fixture"}, probe: "nonce"}
	conn := socks(t, ep, ep.config.Password)
	host := "nonce.fixture.bluewing.invalid"
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, 1)
	conn.Write(req)
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		t.Fatal("probe failed", err)
	}
	body, err := io.ReadAll(conn)
	if err != nil || !strings.HasSuffix(string(body), "\r\n\r\nnonce") {
		t.Fatal("probe did not return session token", err)
	}
}
func TestCompanyDNSOfflineAndNoPublicFallback(t *testing.T) {
	c, ep := fixture(t)
	q := new(dns.Msg)
	q.SetQuestion("dev.corp.example.", dns.TypeA)
	dnsClient := &dns.Client{Net: "tcp", Timeout: time.Second}
	response, _, err := dnsClient.Exchange(q, ep.dns.Listener.Addr().String())
	if err != nil || response.Rcode != dns.RcodeServerFailure {
		t.Fatal("offline DNS should SERVFAIL", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.active = &session{ctx: ctx, cancel: cancel, p: profile{ID: "fixture", Hosts: map[string][]string{"dev.corp.example": {"10.20.30.40"}}}, resources: resources{Hosts: map[string][]string{"dev.corp.example": {"10.99.0.1"}}}, leases: map[string]dnsLease{}}
	response, _, err = dnsClient.Exchange(q, ep.dns.Listener.Addr().String())
	if err != nil || len(response.Answer) != 1 {
		t.Fatal("company hosts not applied", err)
	}
	if record, ok := response.Answer[0].(*dns.A); !ok || record.A.String() != "10.20.30.40" {
		t.Fatal("user fixed DNS must override server DNS", response.Answer)
	}
	if ip, err := c.active.lookup(ctx, "dev.corp.example"); err != nil || ip.String() != "10.20.30.40" {
		t.Fatal("SOCKS lookup must prefer user fixed DNS", ip, err)
	}
	q.SetQuestion("www.public.example.", dns.TypeA)
	response, _, err = dnsClient.Exchange(q, ep.dns.Listener.Addr().String())
	if err != nil || response.Rcode != dns.RcodeRefused {
		t.Fatal("public query escaped", err)
	}
	q.SetQuestion("dev.corp.example.", dns.TypeAAAA)
	response, _, err = dnsClient.Exchange(q, ep.dns.Listener.Addr().String())
	if err != nil || response.Rcode != dns.RcodeSuccess || len(response.Answer) != 0 {
		t.Fatal("IPv4-only host must return empty AAAA", err)
	}
}
func TestTrustedEndpointFailureKeepsServerEvidence(t *testing.T) {
	err := fmt.Errorf("authCheck failed with code 75500503: client is not installed")
	if safeCode(err) != "ATRUST_TRUSTED_ENDPOINT_REQUIRED" {
		t.Fatal("trusted endpoint error misclassified")
	}
	d := failureDetail(err)
	if d["stage"] != "authCheck" || d["serverCode"] != "75500503" || d["message"] != err.Error() {
		t.Fatal("original error lost", d)
	}
}
