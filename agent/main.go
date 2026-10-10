package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// agentVersion is injected at build time via:
//
//	go build -ldflags="-X main.agentVersion=x.y.z"
//
// The agent/VERSION file is the single source of truth — no need to edit this file.
var agentVersion = "dev"

// ── Helpers ───────────────────────────────────────────────────────────────────

func generateUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ── Version comparison ────────────────────────────────────────────────────────

// parseSemver parses a "MAJOR.MINOR.PATCH" string (leading "v" is stripped).
// Returns (0,0,0) on any parse error so malformed versions are treated as
// lower than any real version.
func parseSemver(v string) (int, int, int) {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return 0, 0, 0
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	patch, _ := strconv.Atoi(parts[2])
	return major, minor, patch
}

// isStrictlyNewer returns true only when remote is strictly greater than current.
func isStrictlyNewer(remote, current string) bool {
	rMaj, rMin, rPatch := parseSemver(remote)
	cMaj, cMin, cPatch := parseSemver(current)
	if rMaj != cMaj {
		return rMaj > cMaj
	}
	if rMin != cMin {
		return rMin > cMin
	}
	return rPatch > cPatch
}

// ── Auto-update ───────────────────────────────────────────────────────────────

// updateRetryDelay is how long the agent waits after an update attempt before
// trying again. On success the process is replaced (Unix) or stopped by
// msiexec (Windows) well before that; on failure (download error, length or
// hash mismatch, installer that did not take over) it stops every heartbeat
// from re-downloading the full payload — fleet-wide — while the server keeps
// advertising a bad build or a wrong hash.
const updateRetryDelay = 15 * time.Minute

var (
	updateMu          sync.Mutex
	updateInProgress  bool
	nextUpdateAttempt time.Time
)

// applyUpdateIfNewer is the legacy, server-advertised auto-update: it applies
// remoteVersion only when it is strictly newer than the running agentVersion
// and the retry window (updateRetryDelay) has elapsed. It is only reached when
// the server explicitly sets autoUpdate:true next to latestVersion (servers
// running with AGENT_LEGACY_AUTO_UPDATE); updates are otherwise admin-driven
// through the 'update' command (applyRequestedUpdate).
func applyUpdateIfNewer(cfg *Config, remoteVersion string) {
	if !isStrictlyNewer(remoteVersion, agentVersion) {
		return
	}
	runUpdate(cfg, remoteVersion, false)
}

// applyRequestedUpdate runs the verified update path for an admin-triggered
// 'update' command. targetVersion is the version the server expects the agent
// to end up on ("" = whatever the server currently publishes). The command is
// explicit, so the version comparison and the retry window are skipped — only
// "already on that version" and "an update is already running" stop it.
// Returns false when nothing was attempted.
func applyRequestedUpdate(cfg *Config, targetVersion string) bool {
	targetVersion = strings.TrimPrefix(strings.TrimSpace(targetVersion), "v")
	if targetVersion != "" && targetVersion == strings.TrimPrefix(agentVersion, "v") {
		log.Printf("Update command: already running v%s — nothing to do", agentVersion)
		return false
	}
	label := targetVersion
	if label == "" {
		label = "latest"
	}
	return runUpdate(cfg, label, true)
}

// runUpdate downloads, verifies and applies an update. Safe to call
// concurrently (WS config messages, commands, legacy push): only one attempt
// runs at a time. Unless force is set, attempts are also spaced by
// updateRetryDelay. Returns false when the attempt was skipped.
//
// The payload is staged in the agent's own directory and verified (length,
// SHA-256 from X-Content-SHA256, payload format) before anything is
// installed; on any failure it is deleted and the current binary keeps
// running. Unix: the process re-execs into the new binary (never returns).
// Windows: msiexec is started and stops/restarts the service via the SCM.
func runUpdate(cfg *Config, remoteVersion string, force bool) bool {
	updateMu.Lock()
	if updateInProgress || (!force && time.Now().Before(nextUpdateAttempt)) {
		busy := updateInProgress
		updateMu.Unlock()
		if force && busy {
			log.Printf("Update command: an update or uninstall is already in progress — ignoring")
		}
		return false
	}
	updateInProgress = true
	updateMu.Unlock()

	defer func() {
		updateMu.Lock()
		updateInProgress = false
		nextUpdateAttempt = time.Now().Add(updateRetryDelay)
		updateMu.Unlock()
	}()

	if force {
		log.Printf("Update command: updating %s → %s, downloading...", agentVersion, remoteVersion)
	} else {
		log.Printf("Auto-update: new version available %s → %s, downloading...", agentVersion, remoteVersion)
	}

	stagedPath, err := downloadUpdate(cfg)
	if err != nil {
		log.Printf("Auto-update: %v — keeping v%s", err, agentVersion)
		return true
	}

	// Notify the server we are about to go offline for an update — only now
	// that a verified payload is ready. This sets the "UPDATING" badge in the
	// UI and suppresses offline alerts for up to 10 minutes, so admins are not
	// paged during a routine update.
	notifyServerUpdating(cfg)

	if err := installUpdate(cfg, stagedPath, remoteVersion); err != nil {
		os.Remove(stagedPath)
		log.Printf("Auto-update: install of v%s failed: %v — keeping v%s", remoteVersion, err, agentVersion)
		return true
	}

	// Windows only (Unix never gets here): msiexec now owns the update and
	// will stop this service through the SCM — no os.Exit needed.
	log.Printf("Auto-update: MSI update to v%s initiated — msiexec will stop and restart the service", remoteVersion)
	return true
}

// downloadUpdate fetches the update payload for this platform into the
// agent's staging directory (see updateStaging) and verifies it. Returns the
// path of the verified file.
//
// On Windows we download the full MSI so that the installer handles service
// registration and any packaged dependencies. On other platforms we download
// the bare binary.
func downloadUpdate(cfg *Config) (string, error) {
	var filename string
	if runtime.GOOS == "windows" {
		// Build-line aware (build_flavor.go): the nt6 build (Windows 7 / 8.1 /
		// 2008 R2 / 2012 / 2012 R2) only ever updates to the nt6 MSI, and a
		// modern agent on Windows NT 6.x moves to it.
		filename = currentAgentMSIName()
	} else {
		filename = fmt.Sprintf("obliview-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
	}

	dir, pattern, err := updateStaging()
	if err != nil {
		return "", fmt.Errorf("cannot prepare update directory: %w", err)
	}

	client := &http.Client{Timeout: 120 * time.Second} // larger timeout for MSI download
	resp, err := client.Get(cfg.ServerURL + "/api/agent/download/" + filename)
	if err != nil {
		return "", fmt.Errorf("download request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download failed (HTTP %d)", resp.StatusCode)
	}

	return saveVerifiedDownload(resp, dir, pattern)
}

// ── Main loop ─────────────────────────────────────────────────────────────────

// backoffSteps / backoffLevel are kept for legacy compatibility with update_notify.go
// and other callers that may reference them on some platforms.
var backoffSteps = []int{5 * 60, 10 * 60, 30 * 60, 60 * 60}
var backoffLevel = 0

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	urlFlag := flag.String("url", "", "Server URL (required on first run)")
	keyFlag := flag.String("key", "", "API key (required on first run)")
	flag.Parse()

	// On Windows: detect service mode and hand off to SCM handler.
	// On Linux: runAsService is a no-op that returns immediately.
	if runAsService(urlFlag, keyFlag) {
		return
	}

	// Interactive / Linux mode
	cfg := setupConfig(*urlFlag, *keyFlag)
	runCmdWS(cfg)
}
