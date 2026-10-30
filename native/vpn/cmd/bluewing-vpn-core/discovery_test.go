package main

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestPrivateDiscoveryNeverProbesPublicOrSpecialAddresses(t *testing.T) {
	for _, host := range []string{"10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.110.117"} {
		if !privateAddress(host) {
			t.Fatal(host)
		}
	}
	called := false
	dial := func(context.Context, string, string) (net.Conn, error) {
		called = true
		return nil, errors.New("unexpected dial")
	}
	picker := privateRoutePicker{local: dial, vpn: dial}
	for _, address := range []string{"1.1.1.1:443", "127.0.0.1:22", "169.254.1.1:80", "172.32.0.1:22", "198.18.0.1:22", "[::1]:22", "[fd00::1]:22", "corp.example:22", "192.168.0.1:0"} {
		if _, _, err := picker.dial(context.Background(), address); err == nil {
			t.Fatal(address)
		}
	}
	if called {
		t.Fatal("non-private traffic entered discovery")
	}
}

func TestSoftEtherNetworkDiscoveryScopeAndResourceGuards(t *testing.T) {
	s := &session{p: profile{Protocol: "softether", AutoDiscoverPrivate: true, TrafficMode: "split"}, privateRoutes: &privateRoutePicker{publicTCP: true}}
	for _, port := range []int{22, 80, 443, 23879} {
		if automatic, allowed := s.classifyTCP("110.42.238.247", port); !automatic || !allowed {
			t.Fatal("public company target never reaches automatic routing", port)
		}
	}
	for _, host := range []string{"0.1.2.3", "127.0.0.1", "169.254.1.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "224.0.0.1", "240.0.0.1", "::1"} {
		if _, allowed := s.classifyTCP(host, 22); allowed {
			t.Fatal("special address entered network discovery", host)
		}
	}
	s.p.Protocol = "easyconnect"
	if _, allowed := s.classifyTCP("110.42.238.247", 22); allowed {
		t.Fatal("public network discovery escaped SoftEther")
	}
	s.p.Protocol = "softether"
	s.p.Targets = []target{{CIDRs: []string{"110.42.238.247/32"}, Ports: []string{"443"}}}
	if _, allowed := s.classifyTCP("110.42.238.247", 22); allowed {
		t.Fatal("explicit company port restriction bypassed")
	}
}

func TestSoftEtherNetworkDiscoveryRetainsLongLivedWinningSocket(t *testing.T) {
	c, ep := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	remote, peer := net.Pipe()
	t.Cleanup(func() { remote.Close(); peer.Close() })
	go io.Copy(peer, peer)
	localCalls, vpnCalls := 0, 0
	picker := &privateRoutePicker{publicTCP: true, local: func(context.Context, string, string) (net.Conn, error) {
		localCalls++
		return nil, errors.New("local unreachable")
	}, vpn: func(context.Context, string, string) (net.Conn, error) {
		vpnCalls++
		return remote, nil
	}}
	c.active = &session{ctx: ctx, cancel: cancel, p: profile{ID: "fixture", Protocol: "softether", TrafficMode: "split", AutoDiscoverPrivate: true}, privateRoutes: picker, conns: make(map[net.Conn]struct{})}
	conn := socks(t, ep, ep.config.Password)
	if _, err := conn.Write([]byte{5, 1, 0, 1, 110, 42, 238, 247, 0, 22}); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		t.Fatal("SSH discovery rejected", err, reply)
	}
	// Pass the SOCKS authentication/dial deadline, then verify ongoing data on
	// the original socket instead of silently opening or replaying a connection.
	time.Sleep(10100 * time.Millisecond)
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte("still-connected")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len("still-connected"))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != "still-connected" {
		t.Fatal("established SSH stream expired with dial context", err)
	}
	if localCalls != 1 || vpnCalls != 1 {
		t.Fatal("connection was retried or replayed", localCalls, vpnCalls)
	}
}

func TestPrivateDiscoveryReusesLocalSocketAndDoesNotContactVPN(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	vpnCalls := 0
	picker := privateRoutePicker{local: func(ctx context.Context, network, address string) (net.Conn, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > time.Second {
			t.Error("local probe not bounded")
		}
		return a, nil
	}, vpn: func(context.Context, string, string) (net.Conn, error) {
		vpnCalls++
		return nil, errors.New("unexpected VPN")
	}}
	conn, outlet, err := picker.dial(context.Background(), "192.168.110.117:22")
	if err != nil || conn != a || outlet != "direct" || vpnCalls != 0 {
		t.Fatal(outlet, err)
	}
	go b.Write([]byte("ok"))
	value := make([]byte, 2)
	if _, err = io.ReadFull(conn, value); err != nil || string(value) != "ok" {
		t.Fatal("original local socket was not retained", err)
	}
}

func TestPrivateDiscoveryCachesExactEndpointWithinSessionAndRechecksAfterExpiry(t *testing.T) {
	localCalls, vpnCalls := 0, 0
	picker := privateRoutePicker{local: func(context.Context, string, string) (net.Conn, error) {
		localCalls++
		return nil, errors.New("local unreachable")
	}, vpn: func(context.Context, string, string) (net.Conn, error) {
		vpnCalls++
		a, b := net.Pipe()
		b.Close()
		return a, nil
	}}
	for i := 0; i < 2; i++ {
		conn, outlet, err := picker.dial(context.Background(), "192.168.110.117:22")
		if err != nil || outlet != "vpn" {
			t.Fatal(err)
		}
		conn.Close()
	}
	if localCalls != 1 || vpnCalls != 2 {
		t.Fatal(localCalls, vpnCalls)
	}
	conn, _, _ := picker.dial(context.Background(), "192.168.110.117:80")
	conn.Close()
	if localCalls != 2 {
		t.Fatal("port scope widened")
	}
	picker.hints["192.168.110.117:22"] = routeHint{outlet: "vpn", expires: time.Now().Add(-time.Second)}
	conn, _, _ = picker.dial(context.Background(), "192.168.110.117:22")
	conn.Close()
	if localCalls != 3 {
		t.Fatal("expired hint not revalidated")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := picker.dial(ctx, "192.168.110.118:22"); !errors.Is(err, context.Canceled) || localCalls != 3 {
		t.Fatal("cancelled discovery still dialed", err)
	}
}

func TestAutomaticPrivateDiscoveryPreservesKnownResourcePortGuards(t *testing.T) {
	s := &session{p: profile{AutoDiscoverPrivate: true, TrafficMode: "split", Targets: []target{{CIDRs: []string{"10.20.0.0/16"}, Ports: []string{"443"}}}}, privateRoutes: &privateRoutePicker{}}
	if !s.automaticPrivate() || s.allowed("10.20.1.1", 22, "tcp") || !s.protectedHost("10.20.1.1") {
		t.Fatal("known resource guard lost")
	}
	if _, allowed := s.classifyTCP("10.20.1.1", 22); allowed {
		t.Fatal("resolved company address escaped its port restriction")
	}
	if automatic, allowed := s.classifyTCP("10.20.1.1", 443); automatic || !allowed {
		t.Fatal("known company address would try a local connection")
	}
	s.p.Targets = []target{{Domains: []string{"corp.example"}, Ports: []string{"443"}}}
	s.leases = map[string]dnsLease{"10.20.1.2": {domain: "corp.example", expires: time.Now().Add(time.Minute)}}
	if !s.protectedHost("10.20.1.2") {
		t.Fatal("DNS-leased resource guard lost")
	}
	s.p.TrafficMode = "custom"
	if s.automaticPrivate() {
		t.Fatal("automatic discovery overrode custom mode")
	}
}

func TestLocalDiscoveryConnectionSurvivesVPNStopAndClosesWithEndpoint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{ctx: ctx, cancel: cancel, conns: make(map[net.Conn]struct{})}
	var local localConnections
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	cleanup, ok := local.track(a, b)
	if !ok {
		t.Fatal("endpoint unexpectedly closed")
	}
	defer cleanup()
	s.close()
	go b.Write([]byte("x"))
	_ = a.SetReadDeadline(time.Now().Add(time.Second))
	value := make([]byte, 1)
	if _, err := a.Read(value); err != nil {
		t.Fatal("VPN disconnect closed a local LAN flow", err)
	}
	local.close()
	if _, err := a.Read(value); err == nil {
		t.Fatal("endpoint shutdown left connection open")
	}
	if _, ok := local.track(a, b); ok {
		t.Fatal("closed endpoint accepted a late connection")
	}
}

func TestAutomaticDiscoverySOCKSForwardsOnceAndOwnsConnectionsCorrectly(t *testing.T) {
	for _, outlet := range []string{"direct", "vpn"} {
		t.Run(outlet, func(t *testing.T) {
			c, ep := fixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			remote, peer := net.Pipe()
			t.Cleanup(func() { remote.Close(); peer.Close() })
			go io.Copy(peer, peer)
			localCalls, vpnCalls := 0, 0
			picker := &privateRoutePicker{local: func(context.Context, string, string) (net.Conn, error) {
				localCalls++
				if outlet == "vpn" {
					return nil, errors.New("local unreachable")
				}
				return remote, nil
			}, vpn: func(context.Context, string, string) (net.Conn, error) { vpnCalls++; return remote, nil }}
			c.active = &session{ctx: ctx, cancel: cancel, p: profile{ID: "fixture", TrafficMode: "split", AutoDiscoverPrivate: true}, privateRoutes: picker, conns: make(map[net.Conn]struct{})}
			conn := socks(t, ep, ep.config.Password)
			if _, err := conn.Write([]byte{5, 1, 0, 1, 192, 168, 77, 12, 0, 22}); err != nil {
				t.Fatal(err)
			}
			reply := make([]byte, 10)
			if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
				t.Fatal("automatic target rejected", err, reply)
			}
			for _, payload := range []string{"first", "second"} {
				if _, err := conn.Write([]byte(payload)); err != nil {
					t.Fatal(err)
				}
				value := make([]byte, len(payload))
				if _, err := io.ReadFull(conn, value); err != nil || string(value) != payload {
					t.Fatal("payload changed or replayed", err)
				}
			}
			if localCalls != 1 || (outlet == "vpn" && vpnCalls != 1) || (outlet == "direct" && vpnCalls != 0) {
				t.Fatal(localCalls, vpnCalls)
			}
			c.stop()
			if outlet == "direct" {
				if _, err := conn.Write([]byte("alive")); err != nil {
					t.Fatal("LAN flow closed with VPN", err)
				}
				value := make([]byte, 5)
				if _, err := io.ReadFull(conn, value); err != nil {
					t.Fatal(err)
				}
				c.closeEndpoints()
			}
			if _, err := conn.Read(make([]byte, 1)); err == nil {
				t.Fatal("owned flow leaked after shutdown")
			}
		})
	}
}
