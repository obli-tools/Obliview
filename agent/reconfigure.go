package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

// ── 'reconfigure' command (tenant transfer) ───────────────────────────────────
//
// The server sends 'reconfigure' {apiKey, serverUrl?} after moving the device
// to another workspace (tenant): the new API key belongs to the target tenant
// and the old one no longer authenticates this device.
//
// The agent:
//  1. validates the new credentials;
//  2. rewrites config.json atomically (config.go saveConfig), recording the
//     replaced key (SHA-256 only) and URL as superseded so stale Windows service
//     arguments cannot revert the change at the next start;
//  3. Windows: best-effort update of the MSI-written registry fallback and of
//     the service arguments (reconfigure_windows.go);
//  4. restarts the service — Windows: a detached Restart-Service / sc
//     stop+start (no script on disk, the key is never on its command line);
//     Linux: systemctl restart; macOS: launchctl kickstart; anything else, or
//     if the restart cannot be launched: in-place re-exec or an immediate WS
//     reconnect with the new credentials.

// reconfigureRequest is the payload of a 'reconfigure' command.
type reconfigureRequest struct {
	APIKey    string
	ServerURL string // optional — empty keeps the current server
}

// reconfigureMu serialises reconfigure commands (a WS command and a queued
// pending_command may arrive back to back).
var reconfigureMu sync.Mutex

// reconfigureRestartDelay leaves time for the WS ack to reach the server
// before the service goes down.
const reconfigureRestartDelay = 2 * time.Second

// handleReconfigureCommand persists the new credentials and schedules the
// service restart. A non-nil error means nothing was changed.
func handleReconfigureCommand(cfg *Config, req reconfigureRequest) error {
	changed, err := applyReconfigure(cfg, req)
	if err != nil {
		log.Printf("Reconfigure: rejected — %v", err)
		return err
	}
	if !changed {
		log.Printf("Reconfigure: credentials unchanged — no restart needed")
		return nil
	}
	go func() {
		time.Sleep(reconfigureRestartDelay)
		restartAfterReconfigure()
	}()
	return nil
}

// validateAPIKey rejects empty, oversized or unsafe keys. Quotes, whitespace
// and control characters are refused: the key is written into the Windows
// service arguments ("--key \"…\"") and must never break out of them.
func validateAPIKey(key string) error {
	if key == "" {
		return errors.New("apiKey is required")
	}
	if len(key) < 8 || len(key) > 512 {
		return fmt.Errorf("apiKey has an invalid length (%d)", len(key))
	}
	for _, r := range key {
		if r == '"' || r == '\'' || r == '\\' || r == '`' || unicode.IsSpace(r) || unicode.IsControl(r) || r > unicode.MaxASCII {
			return errors.New("apiKey contains invalid characters")
		}
	}
	return nil
}

// normalizeServerURL validates a new server URL and returns it without a
// trailing slash. HTTPS → HTTP downgrades are refused.
func normalizeServerURL(raw, current string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if len(raw) > 2048 {
		return "", errors.New("serverUrl is too long")
	}
	for _, r := range raw {
		if r == '"' || r == '\'' || r == '\\' || r == '`' || unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", errors.New("serverUrl contains invalid characters")
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("serverUrl is not a valid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("serverUrl must use http or https (got %q)", u.Scheme)
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("serverUrl must be a plain http(s)://host[:port][/path] URL")
	}
	if strings.HasPrefix(strings.ToLower(current), "https://") && u.Scheme == "http" {
		return "", errors.New("refusing to downgrade the server URL from https to http")
	}
	return raw, nil
}

// removeString returns list without s.
func removeString(list []string, s string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

// applyReconfigure validates the request and writes the new credentials to
// config.json (atomically), then to the Windows registry / service arguments
// (best-effort), and finally to the in-memory cfg. Returns changed=false when
// the request matches the current configuration.
func applyReconfigure(cfg *Config, req reconfigureRequest) (bool, error) {
	reconfigureMu.Lock()
	defer reconfigureMu.Unlock()

	newKey := strings.TrimSpace(req.APIKey)
	if err := validateAPIKey(newKey); err != nil {
		return false, err
	}
	newURL := cfg.ServerURL
	if strings.TrimSpace(req.ServerURL) != "" {
		u, err := normalizeServerURL(req.ServerURL, cfg.ServerURL)
		if err != nil {
			return false, err
		}
		newURL = u
	}

	if newKey == cfg.APIKey && newURL == cfg.ServerURL {
		return false, nil
	}

	// Work on a copy so a failed write leaves the running config untouched.
	next := *cfg
	next.SupersededAPIKeys = append([]string(nil), cfg.SupersededAPIKeys...)
	next.SupersededServerURLs = append([]string(nil), cfg.SupersededServerURLs...)

	if newKey != cfg.APIKey {
		next.SupersededAPIKeys = appendBounded(next.SupersededAPIKeys, hashSecret(cfg.APIKey))
		next.SupersededAPIKeys = removeString(next.SupersededAPIKeys, hashSecret(newKey))
		next.APIKey = newKey
	}
	if newURL != cfg.ServerURL {
		next.SupersededServerURLs = appendBounded(next.SupersededServerURLs, cfg.ServerURL)
		next.SupersededServerURLs = removeString(next.SupersededServerURLs, newURL)
		next.ServerURL = newURL
	}
	// The 401 back-off belonged to the old credentials.
	next.BackoffUntil = 0

	if err := saveConfig(&next); err != nil {
		return false, fmt.Errorf("could not write %s: %w", configFile, err)
	}

	// Windows: keep the MSI-written registry fallback and the service
	// arguments in line. Not fatal — config.json is authoritative and the
	// superseded lists neutralise stale service arguments.
	if err := persistPlatformCredentials(next.ServerURL, next.APIKey); err != nil {
		log.Printf("Reconfigure: warning — %v", err)
	}

	cfg.APIKey = next.APIKey
	cfg.ServerURL = next.ServerURL
	cfg.SupersededAPIKeys = next.SupersededAPIKeys
	cfg.SupersededServerURLs = next.SupersededServerURLs
	cfg.BackoffUntil = 0
	backoffLevel = 0

	log.Printf("Reconfigure: new credentials saved to %s (server: %s)", configFile, next.ServerURL)
	return true, nil
}

// restartAfterReconfigure restarts the agent so every component picks up the
// new credentials. If the service manager restart cannot be launched, the
// command channel is closed instead: runCmdWS reconnects at once with the
// in-memory config, which already holds the new credentials.
func restartAfterReconfigure() {
	if err := restartAgentService(); err != nil {
		log.Printf("Reconfigure: service restart unavailable (%v) — reconnecting with the new credentials", err)
		closeActiveCmdWS()
		return
	}
	log.Printf("Reconfigure: service restart launched")
}
