package main

// Fallback root CAs for Windows < 10 (nt6 build line).
//
// Windows 7 / Server 2008 R2 / 2012 machines whose automatic root update is
// disabled, blocked or offline lack ISRG Root X1 (Let's Encrypt) and other
// post-2015 roots in their certificate store: every HTTPS / WSS connection to
// the server then fails with x509 "certificate signed by unknown authority".
//
// On those systems ONLY (useFallbackRoots), the agent's connections to the
// server use RootCAs = the Windows system pool + the small embedded,
// documented root set of fallback_roots.pem. Verification stays entirely in
// crypto/tls (no InsecureSkipVerify, no custom verifier): on Windows a pool
// obtained from x509.SystemCertPool is first verified by the platform
// (CertGetCertificateChain), and Go falls back to its own verifier with the
// appended roots only when the platform check fails. In both cases the
// expected host is tls.Config.ServerName — the dialled host, DNS name OR IP
// literal (http.Transport and wsConnect set it per connection) — so the
// host-name / IP SAN check always applies and fails closed. Chain
// signatures, validity dates and key usage are checked as usual.
//
// Wired into the command channel (wsConnect -> serverTLSConfig) and into
// http.DefaultTransport (update download, notifying-update, legacy push) by
// init below. Proxy monitor checks keep their own transport (their targets
// are not the server). Windows 10+ and other OSes are untouched.

import (
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"log"
	"net/http"
	"sync"
)

//go:embed fallback_roots.pem
var fallbackRootsPEM []byte

var (
	fallbackRootsOnce sync.Once
	fallbackRootsPool *x509.CertPool

	serverRootsOnce sync.Once
	serverRootsPool *x509.CertPool
)

// fallbackRoots parses the embedded roots once (alone, without the system store).
func fallbackRoots() *x509.CertPool {
	fallbackRootsOnce.Do(func() {
		p := x509.NewCertPool()
		if !p.AppendCertsFromPEM(fallbackRootsPEM) {
			log.Printf("TLS: embedded fallback roots could not be parsed")
		}
		fallbackRootsPool = p
	})
	return fallbackRootsPool
}

// withFallbackRoots returns base (or an empty pool when nil) with the
// embedded roots appended. base is modified in place: pass a copy.
func withFallbackRoots(base *x509.CertPool) *x509.CertPool {
	if base == nil {
		base = x509.NewCertPool()
	}
	if !base.AppendCertsFromPEM(fallbackRootsPEM) {
		log.Printf("TLS: embedded fallback roots could not be parsed")
	}
	return base
}

// serverRoots is the system pool plus the embedded roots, built once.
// x509.SystemCertPool returns a fresh copy, so appending never alters the
// process-wide system pool.
func serverRoots() *x509.CertPool {
	serverRootsOnce.Do(func() {
		sys, err := x509.SystemCertPool()
		if err != nil {
			log.Printf("TLS: system root pool unavailable (%v): using the embedded roots only", err)
			sys = nil
		}
		serverRootsPool = withFallbackRoots(sys)
	})
	return serverRootsPool
}

// fallbackTLSConfig returns a client config whose roots are the system store
// plus the embedded fallback roots. ServerName is left empty: http.Transport
// fills it per connection (IP literals included), wsConnect sets it.
func fallbackTLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    serverRoots(),
	}
}

// useFallbackRoots: Windows < 10 (NT 6.x) only.
func useFallbackRoots() bool { return osNeedsNT6Build() }

// serverTLSConfig is the base config of the command channel (wsConnect): the
// fallback-aware config on Windows < 10, a plain default elsewhere. The
// caller sets ServerName.
func serverTLSConfig() *tls.Config {
	if useFallbackRoots() {
		return fallbackTLSConfig()
	}
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// On Windows < 10, every http.Client of the agent that uses the default
// transport (update download, notifying-update, legacy push) gets the
// fallback-aware roots.
func init() {
	if !useFallbackRoots() {
		return
	}
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		t := base.Clone()
		t.TLSClientConfig = fallbackTLSConfig()
		http.DefaultTransport = t
	}
}
