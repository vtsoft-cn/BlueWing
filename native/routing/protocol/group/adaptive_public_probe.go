package group

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/sagernet/sing-box/adapter"
	C "github.com/sagernet/sing-box/constant"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

const (
	adaptiveProbeTimeout = 5 * time.Second
	adaptiveSampleBytes  = 64 * 1024
	alternateDNSDelay    = 250 * time.Millisecond
)

var nonPublicRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func eligiblePublicHost(host string) bool {
	if len(host) > 253 || !strings.Contains(host, ".") {
		return false
	}
	for _, suffix := range []string{".local", ".lan", ".localhost", ".localdomain", ".internal", ".corp", ".home.arpa", ".test", ".example", ".invalid", ".onion"} {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	return net.ParseIP(host) == nil
}

func publicAnswers(answers []netip.Addr) bool {
	if len(answers) == 0 {
		return false
	}
	for _, answer := range answers {
		ip := answer.Unmap()
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.Zone() != "" {
			return false
		}
		for _, prefix := range nonPublicRanges {
			if prefix.Contains(ip) {
				return false
			}
		}
	}
	return true
}

type adaptiveSample struct {
	ip      netip.Addr
	elapsed time.Duration
	bytes   int64
}

func (a *AdaptivePublic) compare(ctx context.Context, host string, proxy adapter.Outbound) netip.Addr {
	// Establish public eligibility with the OS resolver first. Split DNS
	// answers must never trigger alternate DNS or public HTTP probes.
	dnsCtx, cancel := context.WithTimeout(ctx, 900*time.Millisecond)
	local, err := net.DefaultResolver.LookupNetIP(dnsCtx, "ip", host)
	cancel()
	if err != nil || !publicAnswers(local) {
		return netip.Addr{}
	}
	return a.comparePublic(ctx, host, local, proxy)
}

func (a *AdaptivePublic) comparePublic(ctx context.Context, host string, local []netip.Addr, proxy adapter.Outbound) netip.Addr {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	started := time.Now()
	proxyResult := make(chan adaptiveSample, 1)
	directResult := make(chan adaptiveSample, 1)
	go func() { proxyResult <- a.sample(ctx, host, M.Socksaddr{Fqdn: host, Port: 443}, proxy, started) }()
	go func() { directResult <- a.sampleDirect(ctx, host, local, started) }()

	var direct, proxied adaptiveSample
	for proxyResult != nil || directResult != nil {
		select {
		case direct = <-directResult:
			directResult = nil
			if !direct.ip.IsValid() {
				return netip.Addr{}
			}
		case proxied = <-proxyResult:
			proxyResult = nil
			if proxied.bytes != 0 && directResult != nil {
				// A completed proxy sample has already won unless a
				// validated direct sample was available at the same time.
				select {
				case direct = <-directResult:
					directResult = nil
				default:
					return netip.Addr{}
				}
			}
		case <-ctx.Done():
			return direct.ip
		}
		if direct.ip.IsValid() && direct.bytes == adaptiveSampleBytes && proxyResult != nil {
			// Once the proxy has already exceeded the threshold, waiting
			// for its timeout cannot make it the faster candidate.
			timer := time.NewTimer(max(0, direct.elapsed*4/3+300*time.Millisecond-time.Since(started)))
			select {
			case proxied = <-proxyResult:
				proxyResult = nil
			case <-timer.C:
				return direct.ip
			case <-ctx.Done():
				timer.Stop()
				return direct.ip
			}
			timer.Stop()
		}
	}
	if direct.ip.IsValid() && (proxied.bytes == 0 ||
		(direct.bytes*2 >= proxied.bytes && proxied.bytes*2 >= direct.bytes &&
			direct.elapsed+225*time.Millisecond < proxied.elapsed*3/4)) {
		return direct.ip
	}
	return netip.Addr{}
}

func (a *AdaptivePublic) sampleDirect(ctx context.Context, host string, local []netip.Addr, started time.Time) adaptiveSample {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan adaptiveSample, 2)
	go func() { results <- a.sampleAddresses(ctx, host, local, started) }()
	go func() {
		timer := time.NewTimer(alternateDNSDelay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			results <- adaptiveSample{}
			return
		}
		if a.dns == nil || a.dnsTags == nil {
			results <- adaptiveSample{}
			return
		}
		transport, found := a.dnsTags.Transport(a.options.AlternateDNS)
		if !found {
			results <- adaptiveSample{}
			return
		}
		answers, err := a.dns.Lookup(ctx, host, adapter.DNSQueryOptions{Transport: transport, Strategy: C.DomainStrategyPreferIPv4})
		if err != nil || !publicAnswers(answers) {
			results <- adaptiveSample{}
			return
		}
		results <- a.sampleAddresses(ctx, host, answers, started)
	}()
	for range 2 {
		select {
		case result := <-results:
			if result.ip.IsValid() {
				return result
			}
		case <-ctx.Done():
			return adaptiveSample{}
		}
	}
	return adaptiveSample{}
}

func (a *AdaptivePublic) sampleAddresses(ctx context.Context, host string, addresses []netip.Addr, started time.Time) adaptiveSample {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Bound each DNS source and let IPv4 and IPv6 compete independently.
	first := addresses[0].Unmap()
	candidates := []netip.Addr{first}
	var second netip.Addr
	for _, address := range addresses[1:] {
		ip := address.Unmap()
		if ip.BitLen() != first.BitLen() {
			second = ip
			break
		}
		if !second.IsValid() && ip != first {
			second = ip
		}
	}
	if second.IsValid() {
		candidates = append(candidates, second)
	}
	results := make(chan adaptiveSample, len(candidates))
	for _, ip := range candidates {
		go func() { results <- a.sample(ctx, host, M.Socksaddr{Addr: ip, Port: 443}, a.direct, started) }()
	}
	for range candidates {
		select {
		case result := <-results:
			if result.bytes != 0 {
				return result
			}
		case <-ctx.Done():
			return adaptiveSample{}
		}
	}
	return adaptiveSample{}
}

func (a *AdaptivePublic) sample(ctx context.Context, host string, destination M.Socksaddr, dialer N.Dialer, started time.Time) adaptiveSample {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, N.NetworkTCP, destination)
		},
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: adapter.RootPoolFromContext(a.ctx)},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	target := url.URL{Scheme: "https", Host: host, Path: "/"}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return adaptiveSample{}
	}
	request.Header.Set("Range", "bytes=0-65535")
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := client.Do(request)
	if err != nil {
		return adaptiveSample{}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return adaptiveSample{}
	}
	bytes, err := io.CopyN(io.Discard, response.Body, adaptiveSampleBytes)
	if bytes == 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return adaptiveSample{}
	}
	return adaptiveSample{ip: destination.Addr, elapsed: time.Since(started), bytes: bytes}
}
