// BlueWing additions to the pinned zju-connect fork. AGPL-3.0, see ../../LICENSE.
package bluewing

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"

	utls "github.com/refraction-networking/utls"
)

type Prompt func(kind, title string, image []byte) (string, error)
type Policy struct {
	CAPEM      string `json:"caPem"`
	Pin        string `json:"pinSha256"`
	ServerName string `json:"serverName"`
}

var mu sync.RWMutex
var prompt Prompt
var policy Policy
var requestContext = context.Background()

func Configure(ctx context.Context, p Policy, f Prompt) {
	mu.Lock()
	defer mu.Unlock()
	requestContext = ctx
	policy = p
	prompt = f
}
func Enabled() bool { mu.RLock(); defer mu.RUnlock(); return prompt != nil }
func Request(kind, title string, image []byte) (string, error) {
	mu.RLock()
	f := prompt
	mu.RUnlock()
	if f == nil {
		return "", errors.New("interactive bridge not configured")
	}
	return f(kind, title, image)
}
func Scan(kind string, value *string) (int, error) {
	if !Enabled() {
		return fmt.Scanln(value)
	}
	v, e := Request(kind, "请输入验证码", nil)
	if e != nil {
		return 0, e
	}
	*value = v
	return 1, nil
}
func ConfirmSMS() error {
	if !Enabled() {
		return nil
	}
	_, e := Request("confirm-sms", "确认向账号绑定的手机发送短信验证码", nil)
	return e
}
func Context() context.Context { mu.RLock(); defer mu.RUnlock(); return requestContext }

type contextTransport struct {
	inner http.RoundTripper
	ctx   context.Context
}

func (t contextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.inner.RoundTrip(r.WithContext(t.ctx))
}
func (t contextTransport) CloseIdleConnections() {
	if closer, ok := t.inner.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
func Transport(t http.RoundTripper) http.RoundTripper {
	if !Enabled() {
		return t
	}
	return contextTransport{t, Context()}
}

func TLS(host string) *tls.Config {
	mu.RLock()
	p := policy
	mu.RUnlock()
	if h, _, e := net.SplitHostPort(host); e == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if p.ServerName != "" {
		host = p.ServerName
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if p.CAPEM != "" {
		roots.AppendCertsFromPEM([]byte(p.CAPEM))
	}
	cfg := &tls.Config{ServerName: host, RootCAs: roots}
	if p.Pin != "" {
		// Explicit leaf-certificate pin is the trust anchor, not an unchecked TLS bypass.
		pin := strings.ToLower(p.Pin)
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("TLS_UNTRUSTED")
			}
			sum := sha256.Sum256(raw[0])
			if hex.EncodeToString(sum[:]) != pin {
				return errors.New("TLS_UNTRUSTED: certificate pin mismatch")
			}
			return nil
		}
	}
	return cfg
}
func UTLS(host string) *utls.Config {
	c := TLS(host)
	return &utls.Config{ServerName: c.ServerName, RootCAs: c.RootCAs, InsecureSkipVerify: c.InsecureSkipVerify, VerifyPeerCertificate: c.VerifyPeerCertificate}
}
