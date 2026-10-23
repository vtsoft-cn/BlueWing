package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"slices"
	"testing"
	"time"
)

func TestCertificateReportDistinguishesTrustNameAndExpiry(t *testing.T) {
	now := time.Now()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "vpn.example.com"}, DNSNames: []string{"vpn.example.com"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	raw, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(raw)
	if err != nil {
		t.Fatal(err)
	}
	chain := []*x509.Certificate{cert}
	untrusted := certificateReport(chain, "192.0.2.10", "", x509.NewCertPool(), now)
	if untrusted.ChainTrusted || !slices.Contains(untrusted.TrustIssues, "UNTRUSTED_AUTHORITY") || !slices.Contains(untrusted.TrustIssues, "NAME_MISMATCH") {
		t.Fatalf("incorrect report: %+v", untrusted)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	trusted := certificateReport(chain, "vpn.example.com", "", roots, now)
	if !trusted.ChainTrusted || len(trusted.TrustIssues) > 0 || len(trusted.Fingerprint) != 64 {
		t.Fatalf("trusted certificate rejected: %+v", trusted)
	}
	expired := certificateReport(chain, "vpn.example.com", "", roots, now.Add(2*time.Hour))
	if expired.ChainTrusted || !slices.Contains(expired.TrustIssues, "EXPIRED") {
		t.Fatal("expired certificate not reported")
	}
	invalid := certificateReport(chain, "vpn.example.com", "invalid CA", roots, now)
	if invalid.ChainTrusted || !slices.Contains(invalid.TrustIssues, "INVALID_CA") {
		t.Fatal("invalid CA accepted")
	}
}
