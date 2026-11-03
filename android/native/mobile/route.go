// Package mobile provides the Android bridge to the BlueWing VPN core.
package mobile

import (
	"fmt"
	"net/netip"
	"strings"
)

// NormalizeRoutes validates user-selected company routes and returns canonical
// IPv4 CIDRs, one per line, for Android's VpnService.Builder.
func NormalizeRoutes(input string) (string, error) {
	routes := strings.FieldsFunc(input, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	})
	if len(routes) == 0 || len(routes) > 128 {
		return "", fmt.Errorf("enter between 1 and 128 company routes")
	}
	privateNetworks := [...]netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
	}
	seen := make(map[netip.Prefix]bool)
	var result []string
	for index, route := range routes {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(route))
		if err != nil || !prefix.Addr().Is4() {
			return "", fmt.Errorf("route %d must be an IPv4 CIDR", index+1)
		}
		prefix = prefix.Masked()
		allowed := false
		for _, network := range privateNetworks {
			if prefix.Bits() >= network.Bits() && network.Contains(prefix.Addr()) {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", fmt.Errorf("route %d must be inside an RFC 1918 private network", index+1)
		}
		if !seen[prefix] {
			seen[prefix] = true
			result = append(result, prefix.String())
		}
	}
	return strings.Join(result, "\n"), nil
}
