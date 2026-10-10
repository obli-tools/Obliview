package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestFallbackRootsPEM: the embedded set is exactly the documented roots.
func TestFallbackRootsPEM(t *testing.T) {
	want := map[string]string{
		"ISRG Root X1":                          "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6",
		"ISRG Root X2":                          "69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470",
		"DigiCert Global Root G2":               "cb3ccbb76031e5e0138f8dd39a23f9de47ffc35e43c1144cea27d46a5ab1cb5f",
		"USERTrust RSA Certification Authority": "e793c9b02fd8aa13e21c31228accb08119643b749c898964b1746d46c3d4cbd2",
		"USERTrust ECC Certification Authority": "4ff460d54b9c86dabfbcfc5712e0400d2bed3fbc4d4fbdaa86e06adcd2a9ad7a",
		"GTS Root R1":                           "d947432abde7b7fa90fc2e6b59101b1280e0e1c7e4e40fa3c6887fff57a7f4cf",
		"GTS Root R4":                           "349dfa4058c5e263123b398ae795573c4e1313c83fe68f93556cd5e8031b3c7d",
	}
	rest := fallbackRootsPEM
	got := 0
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		c, err := x509.ParseCertificate(b.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(c.Raw)
		if fp, ok := want[c.Subject.CommonName]; !ok || fp != hex.EncodeToString(sum[:]) {
			t.Errorf("unexpected root %q %x", c.Subject.CommonName, sum)
		}
		if !c.IsCA || c.NotAfter.Before(time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)) {
			t.Errorf("root %q: CA=%v notAfter=%s", c.Subject.CommonName, c.IsCA, c.NotAfter)
		}
		got++
	}
	if got != len(want) {
		t.Errorf("%d roots, want %d", got, len(want))
	}
	if fallbackRoots() == nil {
		t.Fatal("pool")
	}
}

type testPKI struct {
	root, inter, leaf *x509.Certificate
	leafKey           *ecdsa.PrivateKey
}

// newTestPKI: root -> intermediate -> leaf whose SANs are exactly dnsNames
// and ips.
func newTestPKI(t *testing.T, dnsNames []string, ips []net.IP, leafNotAfter time.Time) testPKI {
	t.Helper()
	mk := func(tmpl, parent *x509.Certificate, pub, signer interface{}) *x509.Certificate {
		der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
		if err != nil {
			t.Fatal(err)
		}
		c, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	now := time.Now()
	rootKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	rootT := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test Root"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	root := mk(rootT, rootT, &rootKey.PublicKey, rootKey)
	interKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	interT := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "Test Inter"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	inter := mk(interT, root, &interKey.PublicKey, rootKey)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafT := &x509.Certificate{SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "Test Leaf"}, NotBefore: now.Add(-time.Hour), NotAfter: leafNotAfter,
		DNSNames: dnsNames, IPAddresses: ips, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	leaf := mk(leafT, inter, &leafKey.PublicKey, interKey)
	return testPKI{root: root, inter: inter, leaf: leaf, leafKey: leafKey}
}

// handshake runs a real crypto/tls handshake over net.Pipe: the client uses
// the fallback wiring (roots = "system store" without the test root + the
// test root as embedded fallback) and dials serverName.
func handshake(t *testing.T, p testPKI, serverName string, withRoot bool) error {
	t.Helper()
	cConn, sConn := net.Pipe()
	defer cConn.Close()
	defer sConn.Close()

	srv := tls.Server(sConn, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{p.leaf.Raw, p.inter.Raw}, PrivateKey: p.leafKey}}})
	go func() { _ = srv.Handshake(); srv.Close() }()

	roots := withFallbackRoots(x509.NewCertPool()) // embedded roots: never sign the test CA
	if withRoot {
		roots.AddCert(p.root)
	}
	cfg := fallbackTLSConfig()
	cfg.RootCAs = roots
	cfg.ServerName = serverName
	cli := tls.Client(cConn, cfg)
	_ = cConn.SetDeadline(time.Now().Add(10 * time.Second))
	return cli.Handshake()
}

func TestFallbackTLSConfigVerifies(t *testing.T) {
	cfg := fallbackTLSConfig()
	if cfg.InsecureSkipVerify || cfg.VerifyConnection != nil || cfg.RootCAs == nil {
		t.Fatal("fallbackTLSConfig must rely on crypto/tls verification with RootCAs")
	}
}

func TestFallbackRootsHostName(t *testing.T) {
	p := newTestPKI(t, []string{"obliview.example"}, nil, time.Now().Add(time.Hour))
	if err := handshake(t, p, "obliview.example", true); err != nil {
		t.Fatalf("fallback root should validate: %v", err)
	}
	if err := handshake(t, p, "obliview.example", false); err == nil || !strings.Contains(err.Error(), "unknown authority") {
		t.Fatalf("without the root: want unknown authority, got %v", err)
	}
	if err := handshake(t, p, "evil.example", true); err == nil {
		t.Fatal("host name mismatch accepted")
	}
}

// IP literal server URL: no SNI is sent, the IP SAN must still be checked.
func TestFallbackRootsIPLiteral(t *testing.T) {
	dnsOnly := newTestPKI(t, []string{"evil.example"}, nil, time.Now().Add(time.Hour))
	if err := handshake(t, dnsOnly, "127.0.0.1", true); err == nil {
		t.Fatal("certificate without the IP SAN accepted for 127.0.0.1")
	}
	withIP := newTestPKI(t, nil, []net.IP{net.ParseIP("127.0.0.1")}, time.Now().Add(time.Hour))
	if err := handshake(t, withIP, "127.0.0.1", true); err != nil {
		t.Fatalf("IP SAN 127.0.0.1 should validate: %v", err)
	}
	if err := handshake(t, withIP, "127.0.0.2", true); err == nil {
		t.Fatal("IP SAN mismatch accepted")
	}
}

func TestFallbackRootsExpired(t *testing.T) {
	p := newTestPKI(t, []string{"obliview.example"}, nil, time.Now().Add(-time.Minute))
	if err := handshake(t, p, "obliview.example", true); err == nil {
		t.Fatal("expired leaf accepted")
	}
}

// End to end through net/http: the transport sets ServerName from the URL
// host, IP literal included.
func TestFallbackTLSHTTP(t *testing.T) {
	p := newTestPKI(t, []string{"obliview.example"}, nil, time.Now().Add(time.Hour))
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) }))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{p.leaf.Raw, p.inter.Raw}, PrivateKey: p.leafKey}}}
	srv.StartTLS()
	defer srv.Close()

	roots := withFallbackRoots(x509.NewCertPool())
	roots.AddCert(p.root)
	cfg := fallbackTLSConfig()
	cfg.RootCAs = roots
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: cfg}}
	// srv.URL is https://127.0.0.1:port and the leaf has no IP SAN.
	if _, err := client.Get(srv.URL); err == nil {
		t.Fatal("IP literal URL accepted with a DNS-only certificate")
	}
}
