package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
	"slices"
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
	roots, _ := x509.SystemCertPool()
	if roots == nil {
		roots = x509.NewCertPool()
	}
	c.emit(event{Type: "serverCertificate", ID: cmd.ID, Data: certificateReport(certs, name, cmd.Profile.TLS.CAPEM, roots, time.Now())})
}

type serverCertificate struct {
	Fingerprint  string   `json:"fingerprint"`
	Subject      string   `json:"subject"`
	Issuer       string   `json:"issuer"`
	ValidFrom    string   `json:"validFrom"`
	ValidTo      string   `json:"validTo"`
	ChainTrusted bool     `json:"chainTrusted"`
	DNSNames     []string `json:"dnsNames"`
	IPAddresses  []string `json:"ipAddresses"`
	TrustIssues  []string `json:"trustIssues"`
}

func certificateReport(certs []*x509.Certificate, name, caPEM string, roots *x509.CertPool, now time.Time) serverCertificate {
	leaf := certs[0]
	sum := sha256.Sum256(leaf.Raw)
	report := serverCertificate{Fingerprint: hex.EncodeToString(sum[:]), Subject: leaf.Subject.String(), Issuer: leaf.Issuer.String(),
		ValidFrom: leaf.NotBefore.UTC().Format(time.RFC3339), ValidTo: leaf.NotAfter.UTC().Format(time.RFC3339),
		DNSNames: append([]string{}, leaf.DNSNames...), IPAddresses: []string{}, TrustIssues: []string{}}
	for _, ip := range leaf.IPAddresses {
		report.IPAddresses = append(report.IPAddresses, ip.String())
	}
	addIssue := func(code string) {
		if !slices.Contains(report.TrustIssues, code) {
			report.TrustIssues = append(report.TrustIssues, code)
		}
	}
	if roots == nil {
		roots = x509.NewCertPool()
	} else {
		roots = roots.Clone()
	}
	if caPEM != "" && !roots.AppendCertsFromPEM([]byte(caPEM)) {
		addIssue("INVALID_CA")
	}
	if leaf.VerifyHostname(name) != nil {
		addIssue("NAME_MISMATCH")
	}
	if now.Before(leaf.NotBefore) {
		addIssue("NOT_YET_VALID")
	}
	if now.After(leaf.NotAfter) {
		addIssue("EXPIRED")
	}
	intermediates := x509.NewCertPool()
	for _, crt := range certs[1:] {
		intermediates.AddCert(crt)
	}
	_, verifyErr := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: now})
	if verifyErr != nil {
		var authority x509.UnknownAuthorityError
		if errors.As(verifyErr, &authority) {
			addIssue("UNTRUSTED_AUTHORITY")
		} else if !slices.Contains(report.TrustIssues, "EXPIRED") && !slices.Contains(report.TrustIssues, "NOT_YET_VALID") {
			addIssue("CHAIN_INVALID")
		}
	}
	report.ChainTrusted = len(report.TrustIssues) == 0
	return report
}
