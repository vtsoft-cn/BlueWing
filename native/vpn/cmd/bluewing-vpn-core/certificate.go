package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
	"strconv"
	"time"

	"github.com/mythologyli/zju-connect/underlay"
)

// Observe a certificate without sending credentials. Trust changes remain a host/UI decision.
func (c *controller) certificate(cmd command) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d, err := underlay.New(underlay.Options{InterfaceName: cmd.Profile.BindInterface, AutoDetect: cmd.Profile.BindInterface == ""})
	if err != nil {
		c.emit(event{Type: "error", ID: cmd.ID, Code: "GATEWAY_UNREACHABLE"})
		return
	}
	defer d.Close()
	raw, err := d.DialContext(ctx, "tcp", net.JoinHostPort(cmd.Profile.Gateway.Host, strconv.Itoa(cmd.Profile.Gateway.Port)))
	if err != nil {
		c.emit(event{Type: "error", ID: cmd.ID, Code: "GATEWAY_UNREACHABLE"})
		return
	}
	defer raw.Close()
	name := cmd.Profile.TLS.ServerName
	if name == "" {
		name = cmd.Profile.Gateway.Host
	}
	conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: name})
	if err = conn.HandshakeContext(ctx); err != nil {
		c.emit(event{Type: "error", ID: cmd.ID, Code: "TLS_HANDSHAKE_FAILED"})
		return
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		c.emit(event{Type: "error", ID: cmd.ID, Code: "TLS_UNTRUSTED"})
		return
	}
	leaf := certs[0]
	sum := sha256.Sum256(leaf.Raw)
	roots, _ := x509.SystemCertPool()
	if roots == nil {
		roots = x509.NewCertPool()
	}
	if cmd.Profile.TLS.CAPEM != "" && !roots.AppendCertsFromPEM([]byte(cmd.Profile.TLS.CAPEM)) {
		err = errors.New("invalid CA")
	}
	intermediates := x509.NewCertPool()
	for _, crt := range certs[1:] {
		intermediates.AddCert(crt)
	}
	_, verifyErr := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: name})
	c.emit(event{Type: "serverCertificate", ID: cmd.ID, Data: map[string]any{"fingerprint": hex.EncodeToString(sum[:]), "subject": leaf.Subject.String(), "issuer": leaf.Issuer.String(), "validTo": leaf.NotAfter.UTC().Format(time.RFC3339), "chainTrusted": err == nil && verifyErr == nil}})
}
