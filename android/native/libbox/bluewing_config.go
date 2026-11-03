package libbox

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/gofrs/uuid/v5"
)

func blueWingProxyConfig(profile, resolvers string) (string, error) {
	link, err := url.Parse(strings.TrimSpace(profile))
	if err != nil || link.Scheme != "vless" || link.User == nil || link.Hostname() == "" {
		return "", errors.New("expected a VLESS share link")
	}
	user, err := uuid.FromString(link.User.Username())
	if _, passwordSet := link.User.Password(); err != nil || passwordSet {
		return "", errors.New("invalid VLESS UUID")
	}
	port, err := strconv.Atoi(link.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("invalid VLESS port")
	}
	query, err := url.ParseQuery(link.RawQuery)
	if err != nil {
		return "", errors.New("invalid VLESS options")
	}
	if value := query.Get("encryption"); value != "" && value != "none" {
		return "", errors.New("unsupported VLESS encryption")
	}
	outbound := map[string]any{
		"type": "vless", "tag": "proxy", "server": link.Hostname(), "server_port": port, "uuid": user.String(),
		"domain_resolver": "bootstrap",
	}
	flow := query.Get("flow")
	switch flow {
	case "":
	case "xtls-rprx-vision":
		outbound["flow"] = flow
	default:
		return "", errors.New("unsupported VLESS flow")
	}
	switch query.Get("type") {
	case "", "tcp", "raw":
		if value := query.Get("headerType"); value != "" && value != "none" {
			return "", errors.New("unsupported TCP header")
		}
	case "ws":
		if flow != "" {
			return "", errors.New("Vision requires TCP transport")
		}
		transport := map[string]any{"type": "ws", "path": query.Get("path")}
		if host := query.Get("host"); host != "" {
			transport["headers"] = map[string]string{"Host": host}
		}
		outbound["transport"] = transport
	default:
		return "", errors.New("unsupported VLESS transport")
	}
	serverName := query.Get("sni")
	if serverName == "" {
		serverName = link.Hostname()
	}
	tls := map[string]any{"enabled": true, "server_name": serverName}
	if alpn := query.Get("alpn"); alpn != "" {
		tls["alpn"] = strings.Split(alpn, ",")
	}
	switch query.Get("security") {
	case "tls":
		if fingerprint := query.Get("fp"); fingerprint != "" {
			tls["utls"] = map[string]any{"enabled": true, "fingerprint": fingerprint}
		}
	case "reality":
		if query.Get("type") == "ws" || query.Get("sni") == "" {
			return "", errors.New("Reality requires TCP and SNI")
		}
		key, err := base64.RawURLEncoding.DecodeString(query.Get("pbk"))
		shortID, shortErr := hex.DecodeString(query.Get("sid"))
		if err != nil || len(key) != 32 || shortErr != nil || len(shortID) > 8 {
			return "", errors.New("invalid Reality public key or short ID")
		}
		fingerprint := query.Get("fp")
		if fingerprint == "" {
			fingerprint = "chrome"
		}
		tls["utls"] = map[string]any{"enabled": true, "fingerprint": fingerprint}
		tls["reality"] = map[string]any{"enabled": true, "public_key": query.Get("pbk"), "short_id": query.Get("sid")}
	default:
		return "", errors.New("only VLESS TLS and Reality are supported")
	}
	outbound["tls"] = tls
	bootstrap := "1.1.1.1"
	for _, candidate := range strings.Fields(resolvers) {
		if ip, err := netip.ParseAddr(candidate); err == nil && !ip.IsUnspecified() && !ip.IsLoopback() {
			bootstrap = ip.String()
			break
		}
	}
	config := map[string]any{
		"log": map[string]any{"disabled": true},
		"inbounds": []any{map[string]any{
			"type": "tun", "tag": "android", "stack": "gvisor", "mtu": 1400, "auto_route": true,
			"address": []string{"172.19.0.1/30", "fdfe:dcba:9876::1/126"}, "dns_address": []string{"172.19.0.2"},
		}},
		"outbounds": []any{outbound},
		"dns": map[string]any{
			"servers": []any{
				map[string]any{"type": "udp", "tag": "bootstrap", "server": bootstrap},
				map[string]any{"type": "https", "tag": "proxy-dns", "server": "1.1.1.1", "detour": "proxy"},
			},
			"final": "proxy-dns",
		},
		"route": map[string]any{
			"auto_detect_interface": true,
			"rules":                 []any{map[string]any{"port": 53, "action": "hijack-dns"}},
			"final":                 "proxy",
		},
	}
	data, err := json.Marshal(config)
	return string(data), err
}
