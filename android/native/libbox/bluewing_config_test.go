//go:build with_gvisor && with_utls

package libbox

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	box "github.com/sagernet/sing-box"
	M "github.com/sagernet/sing/common/metadata"
)

func TestBlueWingPublicProxyConfig(t *testing.T) {
	const node = "vless://a5db888c-66d8-4000-b1d0-01e57a64901a@node.example:443"
	for _, params := range []string{
		"security=tls&type=ws&sni=node.example&path=%2Fws",
		"security=reality&type=tcp&flow=xtls-rprx-vision&sni=example.org&pbk=YQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=01",
	} {
		config, err := blueWingProxyConfig(node+"?"+params, "192.0.2.53")
		if err != nil {
			t.Fatal(err)
		}
		if err := CheckConfig(config); err != nil {
			t.Fatal(err)
		}
	}
	for _, params := range []string{"security=none", "security=tls&type=xhttp", "security=reality&type=tcp"} {
		if _, err := blueWingProxyConfig(node+"?"+params, ""); err == nil {
			t.Fatalf("accepted unsupported options %q", params)
		}
	}
}

func TestBlueWingVLESSCarriesTraffic(t *testing.T) {
	const id = "a5db888c-66d8-4000-b1d0-01e57a64901a"
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "BlueWing proxy fixture")
	}))
	defer target.Close()
	certFixture := httptest.NewTLSServer(http.NotFoundHandler())
	pair := certFixture.TLS.Certificates[0]
	certFixture.Close()
	cert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pair.Certificate[0]}))
	keyBytes, err := x509.MarshalPKCS8PrivateKey(pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyBytes}))

	portListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := portListener.Addr().(*net.TCPAddr).Port
	_ = portListener.Close()
	start := func(config map[string]any) *box.Box {
		t.Helper()
		raw, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		ctx := baseContext(nil)
		options, err := parseConfig(ctx, string(raw))
		if err != nil {
			t.Fatal(err)
		}
		instance, err := box.New(box.Options{Context: ctx, Options: options})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = instance.Close() })
		if err := instance.Start(); err != nil {
			t.Fatal(err)
		}
		return instance
	}
	start(map[string]any{
		"inbounds": []any{map[string]any{
			"type": "vless", "listen": "127.0.0.1", "listen_port": port,
			"users": []any{map[string]any{"uuid": id}},
			"tls":   map[string]any{"enabled": true, "certificate": cert, "key": key},
		}},
		"outbounds": []any{map[string]any{"type": "direct"}},
	})
	generated, err := blueWingProxyConfig("vless://"+id+"@127.0.0.1:"+strconv.Itoa(port)+"?security=tls", "")
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(generated), &config); err != nil {
		t.Fatal(err)
	}
	// Use the same generated outbound without requiring a host TUN adapter.
	delete(config, "inbounds")
	config["route"].(map[string]any)["auto_detect_interface"] = false
	config["outbounds"].([]any)[0].(map[string]any)["tls"].(map[string]any)["certificate"] = cert
	outbound, found := start(config).Outbound().Outbound("proxy")
	if !found {
		t.Fatal("generated proxy outbound missing")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return outbound.DialContext(ctx, network, M.ParseSocksaddr(address))
		},
	}}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "BlueWing proxy fixture" {
		t.Fatalf("unexpected proxied response %q: %v", body, err)
	}
}
