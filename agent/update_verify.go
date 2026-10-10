package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
)

// ── Update download verification ──────────────────────────────────────────────
//
// The server serves the update payload (MSI on Windows, bare binary elsewhere)
// with two integrity headers:
//
//   - Content-Length   — exact byte count of the file
//   - X-Content-SHA256 — lowercase hex SHA-256 of the file
//
// The payload is written to a staging file and checked against both BEFORE
// anything is installed; on any mismatch the staging file is deleted and the
// running binary is left untouched. Servers that predate X-Content-SHA256 are
// still accepted (backward compatibility) but a warning is logged.

// maxUpdateSize caps a download whose length is not announced, so a
// misbehaving server or proxy cannot fill the disk. Real payloads are 5–15 MB.
const maxUpdateSize int64 = 256 << 20

// saveVerifiedDownload streams resp.Body into a new file created in dir with
// os.CreateTemp(dir, pattern), then verifies it (length, SHA-256, payload
// format). It returns the path of the verified file; on any error the file has
// already been removed.
func saveVerifiedDownload(resp *http.Response, dir, pattern string) (string, error) {
	// resp.ContentLength is -1 when the header is absent (chunked transfer, or
	// a body Go transparently decompressed). The hash still covers that case.
	expectedLen := resp.ContentLength
	expectedHash := strings.TrimSpace(resp.Header.Get("X-Content-SHA256"))

	if expectedHash == "" {
		log.Printf("Auto-update: WARNING — server sent no X-Content-SHA256 header (older server?); download integrity cannot be verified")
	}
	if expectedLen < 0 {
		log.Printf("Auto-update: WARNING — server sent no Content-Length; download length cannot be verified")
	} else if expectedLen > maxUpdateSize {
		return "", fmt.Errorf("announced size %d bytes exceeds the %d-byte limit", expectedLen, maxUpdateSize)
	}

	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", fmt.Errorf("cannot create staging file in %s: %w", dir, err)
	}
	path := f.Name()

	// Read at most one byte more than expected so an oversized body is caught
	// by the length check instead of being silently cut to the right size.
	limit := maxUpdateSize + 1
	if expectedLen >= 0 {
		limit = expectedLen + 1
	}
	written, copyErr := io.Copy(f, io.LimitReader(resp.Body, limit))
	syncErr := f.Sync()
	closeErr := f.Close()
	switch {
	case copyErr != nil:
		os.Remove(path)
		return "", fmt.Errorf("download write error: %w", copyErr)
	case syncErr != nil:
		os.Remove(path)
		return "", fmt.Errorf("staging file sync error: %w", syncErr)
	case closeErr != nil:
		os.Remove(path)
		return "", fmt.Errorf("staging file close error: %w", closeErr)
	case expectedLen < 0 && written > maxUpdateSize:
		os.Remove(path)
		return "", fmt.Errorf("download exceeds the %d-byte limit", maxUpdateSize)
	}

	if err := verifyDownload(path, expectedLen, expectedHash); err != nil {
		os.Remove(path)
		return "", fmt.Errorf("verification failed: %w", err)
	}
	if err := verifyPayloadFormat(path, runtime.GOOS); err != nil {
		os.Remove(path)
		return "", fmt.Errorf("verification failed: %w", err)
	}
	if expectedHash != "" {
		log.Printf("Auto-update: download verified (%d bytes, SHA-256 OK)", written)
	}
	return path, nil
}

// verifyDownload checks the file at path against the length and SHA-256 the
// server announced. expectedLen < 0 skips the length check (no Content-Length)
// and an empty expectedSHA256 skips the hash check (older server — the caller
// logs the warning). An empty file is always rejected.
func verifyDownload(path string, expectedLen int64, expectedSHA256 string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return errors.New("downloaded file is empty")
	}
	if expectedLen >= 0 && info.Size() != expectedLen {
		return fmt.Errorf("length mismatch: got %d bytes, server announced %d (truncated or altered download)",
			info.Size(), expectedLen)
	}
	if expectedSHA256 == "" {
		return nil
	}
	return verifyFileSHA256(path, expectedSHA256)
}

// verifyFileSHA256 checks the SHA-256 of a downloaded file against the
// expected hex hash (case-insensitive). Ported from the Obliance agent, but
// returns an error so the caller can log why the update was rejected, and
// treats a malformed hash as a failure rather than as "no hash".
func verifyFileSHA256(filePath, expectedHash string) error {
	want := strings.ToLower(strings.TrimSpace(expectedHash))
	if len(want) != sha256.Size*2 {
		return fmt.Errorf("malformed X-Content-SHA256 header (%d characters, expected %d hex digits)",
			len(want), sha256.Size*2)
	}
	if _, err := hex.DecodeString(want); err != nil {
		return errors.New("malformed X-Content-SHA256 header (not hexadecimal)")
	}

	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("hashing %s: %w", filePath, err)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != want {
		return fmt.Errorf("SHA-256 mismatch: got %s, server announced %s", got, want)
	}
	return nil
}

// Leading bytes of the payloads the agent can install. Checked even when the
// server sends a hash: it is what stops an HTML error or captive-portal page
// served by an older server (no hash) from being renamed over the binary.
var (
	msiMagic    = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1} // OLE compound file (.msi)
	elfMagic    = []byte{0x7F, 'E', 'L', 'F'}
	machoMagics = [][]byte{
		{0xCF, 0xFA, 0xED, 0xFE}, // MH_MAGIC_64, little-endian (amd64 / arm64)
		{0xCE, 0xFA, 0xED, 0xFE}, // MH_MAGIC, little-endian
		{0xCA, 0xFE, 0xBA, 0xBE}, // FAT_MAGIC (universal binary)
		{0xCA, 0xFE, 0xBA, 0xBF}, // FAT_MAGIC_64
	}
)

// verifyPayloadFormat checks that the file starts with the magic bytes of the
// payload expected on goos: an MSI on Windows, Mach-O on macOS, ELF elsewhere.
func verifyPayloadFormat(path, goos string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 8)
	n, _ := io.ReadFull(f, head)
	head = head[:n]

	var want [][]byte
	var kind string
	switch goos {
	case "windows":
		want, kind = [][]byte{msiMagic}, "an MSI package"
	case "darwin":
		want, kind = machoMagics, "a Mach-O executable"
	default:
		want, kind = [][]byte{elfMagic}, "an ELF executable"
	}
	for _, m := range want {
		if bytes.HasPrefix(head, m) {
			return nil
		}
	}
	return fmt.Errorf("downloaded file is not %s (starts with % x) — error page or proxy response?", kind, head)
}
