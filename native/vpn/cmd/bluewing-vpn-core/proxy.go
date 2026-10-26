package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/miekg/dns"
	"github.com/mythologyli/zju-connect/client"
	"github.com/mythologyli/zju-connect/resolve"
)

type endpoint struct {
	config   endpointConfig
	listener net.Listener
	dns      *dns.Server
	sem      chan struct{}
}

func (c *controller) configure(configs []endpointConfig) error {
	if len(configs) > 32 {
		return errors.New("too many endpoints")
	}
	c.stop()
	c.closeEndpoints()
	for _, cfg := range configs {
		if cfg.Profile.ID == "" || cfg.User == "" || cfg.Password == "" || len(cfg.User) > 255 || len(cfg.Password) > 255 {
			return errors.New("invalid endpoint")
		}
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Profile.SocksPort)))
		if err != nil {
			c.closeEndpoints()
			return err
		}
		dnsListener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Profile.DNSPort)))
		if err != nil {
			_ = listener.Close()
			c.closeEndpoints()
			return err
		}
		ep := &endpoint{config: cfg, listener: listener, sem: make(chan struct{}, 128)}
		ep.dns = &dns.Server{Listener: dnsListener, Net: "tcp", Handler: dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) { c.answerDNS(cfg.Profile.ID, w, q) }), ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, MaxTCPQueries: 64}
		c.endpoints[cfg.Profile.ID] = ep
		go ep.dns.ActivateAndServe()
		go func() {
			for {
				conn, e := listener.Accept()
				if e != nil {
					return
				}
				select {
				case ep.sem <- struct{}{}:
					go func() { defer func() { <-ep.sem }(); defer conn.Close(); c.serveSOCKS(ep, conn) }()
				default:
					_ = conn.Close()
				}
			}
		}()
	}
	return nil
}
func (c *controller) closeEndpoints() {
	for _, ep := range c.endpoints {
		_ = ep.listener.Close()
		_ = ep.dns.Shutdown()
	}
	c.endpoints = make(map[string]*endpoint)
}
func (c *controller) getSession(id string) *session {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.active != nil && c.active.p.ID == id && c.active.ctx.Err() == nil {
		return c.active
	}
	return nil
}
func readByte(r io.Reader) (byte, error) { b := []byte{0}; _, e := io.ReadFull(r, b); return b[0], e }
func readText(r io.Reader) (string, error) {
	n, e := readByte(r)
	if e != nil {
		return "", e
	}
	b := make([]byte, int(n))
	_, e = io.ReadFull(r, b)
	return string(b), e
}
func (c *controller) serveSOCKS(ep *endpoint, conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	ver, e := readByte(r)
	if e != nil || ver != 5 {
		return
	}
	n, e := readByte(r)
	if e != nil {
		return
	}
	methods := make([]byte, int(n))
	if _, e = io.ReadFull(r, methods); e != nil {
		return
	}
	found := false
	for _, m := range methods {
		if m == 2 {
			found = true
		}
	}
	if !found {
		_, _ = conn.Write([]byte{5, 255})
		return
	}
	_, _ = conn.Write([]byte{5, 2})
	ver, e = readByte(r)
	if e != nil || ver != 1 {
		return
	}
	user, e := readText(r)
	if e != nil {
		return
	}
	pass, e := readText(r)
	if e != nil {
		return
	}
	if subtle.ConstantTimeCompare([]byte(user), []byte(ep.config.User)) != 1 || subtle.ConstantTimeCompare([]byte(pass), []byte(ep.config.Password)) != 1 {
		_, _ = conn.Write([]byte{1, 1})
		return
	}
	_, _ = conn.Write([]byte{1, 0})
	head := make([]byte, 4)
	if _, e = io.ReadFull(r, head); e != nil || head[0] != 5 || head[1] != 1 {
		_, _ = conn.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	var host string
	switch head[3] {
	case 1:
		b := make([]byte, 4)
		if _, e = io.ReadFull(r, b); e != nil {
			return
		}
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		if _, e = io.ReadFull(r, b); e != nil {
			return
		}
		host = net.IP(b).String()
	case 3:
		host, e = readText(r)
		if e != nil {
			return
		}
	default:
		return
	}
	portBytes := make([]byte, 2)
	if _, e = io.ReadFull(r, portBytes); e != nil {
		return
	}
	port := int(binary.BigEndian.Uint16(portBytes))
	s := c.getSession(ep.config.Profile.ID)
	reject := func() { _, _ = conn.Write([]byte{5, 2, 0, 1, 0, 0, 0, 0, 0, 0}) }
	if s == nil {
		reject()
		return
	}
	s.probeMu.RLock()
	probe := s.probe
	s.probeMu.RUnlock()
	if probe != "" && host == probe+"."+s.p.ID+".bluewing.invalid" && port == 1 {
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "+strconv.Itoa(len(probe))+"\r\nConnection: close\r\n\r\n"+probe)
		return
	}
	if !s.allowed(host, port, "tcp") {
		reject()
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	ip := net.ParseIP(host)
	name := normalizeHost(host)
	if ip == nil {
		ip, e = s.lookup(ctx, name)
		if e != nil {
			reject()
			return
		}
	} else {
		s.leaseMu.RLock()
		lease := s.leases[ip.String()]
		s.leaseMu.RUnlock()
		if lease.expires.After(time.Now()) {
			name = lease.domain
		}
	}
	if ip.To4() == nil {
		reject()
		return
	}
	ctx = context.WithValue(ctx, resolve.ContextKeyResolveHost, name)
	for domain, rs := range s.domainResources {
		if domainMatch(name, domain) {
			if res, ok := client.MatchDomainResource(rs, "tcp", port); ok {
				ctx = context.WithValue(ctx, resolve.ContextKeyDomainResource, res)
				break
			}
		}
	}
	remote, e := s.stack.DialTCP(ctx, &net.TCPAddr{IP: ip, Port: port})
	if e != nil {
		reject()
		return
	}
	defer remote.Close()
	s.connsMu.Lock()
	if s.ctx.Err() != nil {
		s.connsMu.Unlock()
		reject()
		return
	}
	s.conns[conn] = struct{}{}
	s.conns[remote] = struct{}{}
	s.connsMu.Unlock()
	defer func() { s.connsMu.Lock(); delete(s.conns, conn); delete(s.conns, remote); s.connsMu.Unlock() }()
	_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	_ = conn.SetDeadline(time.Time{})
	done := make(chan struct{})
	go func() { _, _ = io.Copy(remote, r); _ = remote.Close(); close(done) }()
	_, _ = io.Copy(conn, remote)
	_ = conn.Close()
	<-done
}
func domainMatch(host, d string) bool {
	d = normalizeHost(strings.TrimPrefix(d, "*."))
	return host == d || strings.HasSuffix(host, "."+d)
}
func targetMatch(t target, host string, port int, network string, ignorePorts bool) bool {
	if t.GuardOnly && !ignorePorts {
		return false
	}
	if !ignorePorts && t.Network != "" && t.Network != network {
		return false
	}
	if !ignorePorts && len(t.Ports) > 0 {
		found := false
		for _, value := range t.Ports {
			p := strings.Split(value, ":")
			a, _ := strconv.Atoi(p[0])
			b := a
			if len(p) == 2 {
				b, _ = strconv.Atoi(p[1])
			}
			if port >= a && port <= b {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	for _, d := range t.Domains {
		if domainMatch(normalizeHost(host), d) {
			return true
		}
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		for _, prefix := range t.CIDRs {
			p, e := netip.ParsePrefix(prefix)
			if e == nil && p.Contains(ip) {
				return true
			}
		}
	}
	return false
}
func (s *session) broadVPN() bool {
	return s.p.TrafficMode == "vpn" || (s.p.TrafficMode == "custom" && (s.p.CustomRouting.Domestic == "vpn" || s.p.CustomRouting.Foreign == "vpn" || s.p.CustomRouting.LAN == "vpn"))
}
func (s *session) allowed(host string, port int, network string) bool {
	// Broad access is explicit and per profile; geographic/public-proxy
	// selection stays in the managed sing-box layer, never in the VPN selector.
	if s.broadVPN() && network == "tcp" && port > 0 && port <= 65535 {
		if ip := net.ParseIP(host); ip == nil {
			return !strings.HasSuffix(host, ".bluewing.invalid")
		} else if ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			return true
		}
	}
	for _, t := range append(append([]target{}, s.p.Targets...), s.resources.Targets...) {
		if targetMatch(t, host, port, network, false) {
			return true
		}
	}
	if net.ParseIP(host) != nil {
		s.leaseMu.RLock()
		lease := s.leases[host]
		s.leaseMu.RUnlock()
		if lease.expires.After(time.Now()) {
			for _, t := range append(append([]target{}, s.p.Targets...), s.resources.Targets...) {
				if targetMatch(t, lease.domain, port, network, false) {
					return true
				}
			}
		}
	}
	return false
}
func (s *session) companyDomain(host string) bool {
	if s.broadVPN() && net.ParseIP(host) == nil && !strings.HasSuffix(host, ".bluewing.invalid") {
		return true
	}
	for _, t := range append(append([]target{}, s.p.Targets...), s.resources.Targets...) {
		if targetMatch(t, host, 0, "", true) {
			return true
		}
	}
	_, a := s.p.Hosts[host]
	_, b := s.resources.Hosts[host]
	return a || b
}
func (s *session) lookup(ctx context.Context, name string) (net.IP, error) {
	for _, hs := range []map[string][]string{s.p.Hosts, s.resources.Hosts} {
		for _, value := range hs[name] {
			if ip := net.ParseIP(value); ip.To4() != nil {
				return ip, nil
			}
		}
	}
	q := new(dns.Msg)
	q.SetQuestion(dns.Fqdn(name), dns.TypeA)
	answer, e := s.exchange(ctx, q)
	if e != nil {
		return nil, e
	}
	for _, rr := range answer.Answer {
		if a, ok := rr.(*dns.A); ok {
			return a.A, nil
		}
	}
	return nil, errors.New("CORPORATE_DNS_FAILED")
}
func (s *session) exchange(ctx context.Context, q *dns.Msg) (*dns.Msg, error) {
	for _, server := range s.resources.DNSServers {
		ip := net.ParseIP(server)
		if ip.To4() == nil {
			continue
		}
		conn, e := s.stack.DialUDP(ctx, &net.UDPAddr{IP: ip, Port: 53})
		if e != nil {
			continue
		}
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		answer, _, e := (&dns.Client{Timeout: 4 * time.Second}).ExchangeWithConnContext(ctx, q, &dns.Conn{Conn: conn})
		_ = conn.Close()
		if e == nil && (answer.Rcode == dns.RcodeSuccess || answer.Rcode == dns.RcodeNameError) {
			return answer, nil
		}
	}
	return nil, errors.New("CORPORATE_DNS_FAILED")
}
func (c *controller) answerDNS(id string, w dns.ResponseWriter, q *dns.Msg) {
	answer := new(dns.Msg)
	answer.SetReply(q)
	answer.Rcode = dns.RcodeServerFailure
	s := c.getSession(id)
	if s == nil || len(q.Question) != 1 {
		_ = w.WriteMsg(answer)
		return
	}
	question := q.Question[0]
	name := normalizeHost(question.Name)
	if !s.companyDomain(name) {
		answer.Rcode = dns.RcodeRefused
		_ = w.WriteMsg(answer)
		return
	}
	if question.Qtype != dns.TypeA && question.Qtype != dns.TypeAAAA {
		answer.Rcode = dns.RcodeSuccess
		_ = w.WriteMsg(answer)
		return
	}
	ips, found := s.p.Hosts[name]
	if !found {
		ips, found = s.resources.Hosts[name]
	}
	if found {
		answer.Rcode = dns.RcodeSuccess
		for _, value := range ips {
			ip := net.ParseIP(value)
			header := dns.RR_Header{Name: question.Name, Rrtype: question.Qtype, Class: dns.ClassINET, Ttl: 60}
			if question.Qtype == dns.TypeA && ip.To4() != nil {
				answer.Answer = append(answer.Answer, &dns.A{Hdr: header, A: ip})
			}
			if question.Qtype == dns.TypeAAAA && ip.To4() == nil && ip.To16() != nil {
				answer.Answer = append(answer.Answer, &dns.AAAA{Hdr: header, AAAA: ip})
			}
		}
	} else {
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
		defer cancel()
		if result, e := s.exchange(ctx, q); e == nil {
			answer = result
		}
	}
	if answer.Rcode == dns.RcodeSuccess {
		s.leaseMu.Lock()
		for _, rr := range answer.Answer {
			if a, ok := rr.(*dns.A); ok {
				s.leases[a.A.String()] = dnsLease{domain: name, expires: time.Now().Add(time.Duration(a.Hdr.Ttl) * time.Second)}
			}
		}
		if len(s.leases) > 8192 {
			for ip, lease := range s.leases {
				if lease.expires.Before(time.Now()) {
					delete(s.leases, ip)
				}
			}
		}
		s.leaseMu.Unlock()
	}
	_ = w.WriteMsg(answer)
}
