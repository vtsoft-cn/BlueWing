package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

type privateDial func(context.Context, string, string) (net.Conn, error)
type routeHint struct {
	outlet  string
	expires time.Time
}

// Hints are session-owned and short-lived, never ownership claims about a subnet.
type privateRoutePicker struct {
	mu         sync.Mutex
	hints      map[string]routeHint
	local, vpn privateDial
}

func privateAddress(host string) bool {
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Is4() && ip.IsPrivate()
}

func (p *privateRoutePicker) dial(ctx context.Context, address string) (net.Conn, string, error) {
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	host, port, err := net.SplitHostPort(address)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || n < 1 || n > 65535 || !privateAddress(host) {
		return nil, "", errors.New("private discovery requires an RFC1918 IPv4 TCP endpoint")
	}
	p.mu.Lock()
	hint := p.hints[address]
	p.mu.Unlock()
	if hint.outlet == "vpn" && time.Now().Before(hint.expires) {
		conn, err := p.vpn(ctx, "tcp", address)
		return conn, "vpn", err
	}
	localCtx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	conn, localErr := p.local(localCtx, "tcp", address)
	cancel()
	outlet := "direct"
	if localErr != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		conn, err = p.vpn(ctx, "tcp", address)
		outlet = "vpn"
	} else {
		err = nil
	}
	if err != nil {
		return nil, outlet, err
	}
	p.mu.Lock()
	if p.hints == nil {
		p.hints = make(map[string]routeHint)
	}
	if len(p.hints) >= 256 {
		for key, value := range p.hints {
			if time.Now().After(value.expires) {
				delete(p.hints, key)
			}
		}
		if len(p.hints) >= 256 {
			for key := range p.hints {
				delete(p.hints, key)
				break
			}
		}
	}
	p.hints[address] = routeHint{outlet: outlet, expires: time.Now().Add(time.Minute)}
	p.mu.Unlock()
	return conn, outlet, nil
}

func (s *session) automaticPrivate() bool {
	return s.p.AutoDiscoverPrivate && (s.p.TrafficMode == "" || s.p.TrafficMode == "split") && s.privateRoutes != nil
}

func (s *session) classifyTCP(host string, port int) (automatic, allowed bool) {
	if s.allowed(host, port, "tcp") {
		return false, true
	}
	return true, !s.protectedHost(host) && s.automaticPrivate()
}

func (s *session) protectedHost(host string) bool {
	if s.companyDomain(host) {
		return true
	}
	s.leaseMu.RLock()
	lease := s.leases[host]
	s.leaseMu.RUnlock()
	return lease.expires.After(time.Now()) && s.companyDomain(lease.domain)
}

func (s *session) resolvePrivate(ctx context.Context, host string) (net.IP, error) {
	if net.ParseIP(host) != nil {
		if privateAddress(host) {
			return net.ParseIP(host), nil
		}
		return nil, errors.New("not a private IPv4 address")
	}
	localCtx, cancel := context.WithTimeout(ctx, time.Second)
	ips, err := s.dialer.LookupIPv4(localCtx, host)
	cancel()
	if err == nil {
		for _, ip := range ips {
			if privateAddress(ip.String()) {
				return ip, nil
			}
		}
		return nil, errors.New("hostname did not resolve to a private IPv4 address")
	}
	ip, err := s.lookup(ctx, normalizeHost(host))
	if err == nil && privateAddress(ip.String()) {
		return ip, nil
	}
	return nil, errors.New("private hostname resolution failed")
}

// Local LAN connections belong to the endpoint, so disconnecting a VPN does not
// tear down a printer/NAS connection that never entered the VPN transport.
type localConnections struct {
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
}

func (l *localConnections) track(a, b net.Conn) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return func() {}, false
	}
	if l.conns == nil {
		l.conns = make(map[net.Conn]struct{})
	}
	l.conns[a], l.conns[b] = struct{}{}, struct{}{}
	return func() { l.mu.Lock(); delete(l.conns, a); delete(l.conns, b); l.mu.Unlock() }, true
}
func (l *localConnections) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	for conn := range l.conns {
		_ = conn.Close()
	}
}
