package mobile

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/miekg/dns"
)

type dnsDial func(context.Context, string, string) (net.Conn, error)

type splitDNS struct {
	suffixes       []string
	companyServers []string
	publicServers  []string
	companyDial    dnsDial
	publicDial     dnsDial
}

func parseDNSSuffixes(input string) ([]string, error) {
	var suffixes []string
	for _, field := range strings.FieldsFunc(input, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	}) {
		name := dns.Fqdn(strings.ToLower(strings.TrimSpace(field)))
		if _, valid := dns.IsDomainName(name); !valid || name == "." || strings.ContainsAny(name, "\\* \t") {
			return nil, fmt.Errorf("invalid company DNS suffix %q", field)
		}
		if _, err := netip.ParseAddr(strings.TrimSuffix(name, ".")); err == nil {
			return nil, fmt.Errorf("company DNS suffix must be a domain, got %q", field)
		}
		suffixes = append(suffixes, name)
	}
	if len(suffixes) > 128 {
		return nil, errors.New("at most 128 company DNS suffixes are supported")
	}
	return suffixes, nil
}

func (r splitDNS) resolve(ctx context.Context, query *dns.Msg) (*dns.Msg, error) {
	if query == nil || query.Response || query.Opcode != dns.OpcodeQuery || len(query.Question) != 1 {
		return nil, errors.New("expected one DNS question")
	}
	name := strings.ToLower(query.Question[0].Name)
	servers, dial := r.publicServers, r.publicDial
	for _, suffix := range r.suffixes {
		if dns.IsSubDomain(suffix, name) {
			servers, dial = r.companyServers, r.companyDial
			break
		}
	}
	if dial == nil {
		return nil, errors.New("DNS path unavailable")
	}
	for _, server := range servers {
		address, err := netip.ParseAddr(server)
		if err != nil || address.IsUnspecified() || address.IsMulticast() {
			continue
		}
		target := net.JoinHostPort(address.String(), "53")
		for _, network := range []string{"udp", "tcp"} {
			answer, err := exchangeDNS(ctx, query, dial, network, target)
			if err != nil || answer == nil {
				break
			}
			if answer.Truncated {
				continue
			}
			if answer.Rcode == dns.RcodeSuccess || answer.Rcode == dns.RcodeNameError {
				return answer, nil
			}
			break
		}
	}
	return nil, errors.New("DNS resolution failed on the selected path")
}

func exchangeDNS(ctx context.Context, query *dns.Msg, dial dnsDial, network, target string) (*dns.Msg, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	conn, err := dial(ctx, network, target)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	answer, _, err := (&dns.Client{Net: network}).ExchangeWithConnContext(ctx, query, &dns.Conn{Conn: conn})
	return answer, err
}
