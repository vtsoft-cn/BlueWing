package bluewing

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExplicitTLSAnchors(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	host := server.Listener.Addr().String()
	prompt := func(string, string, []byte) (string, error) { return "", nil }
	Configure(context.Background(), Policy{}, prompt)
	if conn, err := tls.Dial("tcp", host, TLS(host)); err == nil {
		conn.Close()
		t.Fatal("untrusted certificate accepted")
	}
	certificate := server.Certificate()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}))
	Configure(context.Background(), Policy{CAPEM: ca}, prompt)
	conn, err := tls.Dial("tcp", host, TLS(host))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	sum := sha256.Sum256(certificate.Raw)
	Configure(context.Background(), Policy{Pin: hex.EncodeToString(sum[:])}, prompt)
	conn, err = tls.Dial("tcp", host, TLS(host))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	Configure(context.Background(), Policy{Pin: "0000000000000000000000000000000000000000000000000000000000000000"}, prompt)
	if conn, err = tls.Dial("tcp", host, TLS(host)); err == nil {
		conn.Close()
		t.Fatal("wrong pin accepted")
	}
}
func TestTransportBindsCancellationToOriginalSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	Configure(ctx, Policy{}, func(string, string, []byte) (string, error) { return "", nil })
	tr := Transport(http.DefaultTransport)
	Configure(context.Background(), Policy{}, func(string, string, []byte) (string, error) { return "", nil })
	cancel()
	request, _ := http.NewRequest("GET", "http://127.0.0.1:1", nil)
	if _, err := tr.RoundTrip(request); err == nil || ctx.Err() == nil {
		t.Fatal("old transport lost session cancellation")
	}
}
