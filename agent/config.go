package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var (
	configDir  string
	configFile string
)

func init() {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("PROGRAMDATA")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		configDir = filepath.Join(programData, "ObliviewAgent")
	} else {
		configDir = "/etc/obliview-agent"
	}
	configFile = filepath.Join(configDir, "config.json")
}

// ── Config ────────────────────────────────────────────────────────────────────
//
// Where the agent's credentials live:
//
//   - config.json (configFile) — the authoritative copy, read at every start.
//   - Windows only: HKLM\SOFTWARE\ObliviewAgent ServerUrl / ApiKey (written by
//     the MSI, used as a fallback when config.json does not exist yet) and the
//     service arguments `--url "[SERVERURL]" --key "[APIKEY]"` (also written by
//     the MSI). CLI flags override config.json at start-up.
//   - macOS / Linux: the launchd plist and systemd unit carry no credentials.
//
// A 'reconfigure' command (reconfigure.go) rewrites config.json and records
// the credentials it replaced in SupersededAPIKeys / SupersededServerURLs, so
// that stale service arguments still holding the old values cannot silently
// revert the change at the next start (see setupConfig).

type Config struct {
	ServerURL            string `json:"serverUrl"`
	APIKey               string `json:"apiKey"`
	DeviceUUID           string `json:"deviceUuid"`
	CheckIntervalSeconds int    `json:"checkIntervalSeconds"`
	AgentVersion         string `json:"agentVersion"`
	BackoffUntil         int64  `json:"_backoffUntil,omitempty"`

	// IdentityV2: DeviceUUID is the shared Obli* device ID acknowledged by
	// the server (device_identity.go). False = legacy hardware-derived ID.
	// Never read DeviceUUID directly at runtime: use currentDeviceUUID().
	IdentityV2 bool `json:"identityV2,omitempty"`

	// SupersededAPIKeys holds the SHA-256 (hex) of API keys replaced by a
	// 'reconfigure' command — never the keys themselves.
	SupersededAPIKeys []string `json:"supersededApiKeys,omitempty"`
	// SupersededServerURLs holds server URLs replaced by a 'reconfigure' command.
	SupersededServerURLs []string `json:"supersededServerUrls,omitempty"`
}

// maxSupersededEntries bounds the superseded-credential history.
const maxSupersededEntries = 8

// configMu serialises config.json writes: the WS read loop, command goroutines
// and the update path may all save the config.
var configMu sync.Mutex

func loadConfig() (*Config, error) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// saveConfig writes config.json atomically: the JSON goes to a temporary file
// in the same directory (mode 0600 — it holds the API key), is flushed, then
// renamed over config.json. A crash or power loss mid-write leaves either the
// old or the new file, never a truncated one.
func saveConfig(cfg *Config) error {
	configMu.Lock()
	defer configMu.Unlock()

	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(configDir, ".config-*.json.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpPath, configFile); err != nil {
		cleanup()
		return fmt.Errorf("replace %s: %w", configFile, err)
	}
	return nil
}

// hashSecret returns the lowercase hex SHA-256 of s.
func hashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// appendBounded appends s to list (once) and keeps the last maxSupersededEntries.
func appendBounded(list []string, s string) []string {
	if s == "" || containsString(list, s) {
		return list
	}
	list = append(list, s)
	if len(list) > maxSupersededEntries {
		list = list[len(list)-maxSupersededEntries:]
	}
	return list
}

// setupConfig loads or creates config from file, registry (Windows), or CLI flags.
func setupConfig(urlArg, keyArg string) *Config {
	cfg, err := loadConfig()
	if err != nil {
		// No config file — try Windows registry as fallback
		regCfg, regErr := loadConfigFromRegistry()
		if regErr == nil {
			cfg = regCfg
		}
	}

	if cfg == nil {
		if urlArg == "" || keyArg == "" {
			fmt.Fprintf(os.Stderr, "First run: provide --url <serverUrl> --key <apiKey>\n")
			fmt.Fprintf(os.Stderr, "Example: obliview-agent --url https://obliview.example.com --key your-api-key\n")
			os.Exit(1)
		}
		cfg = &Config{
			ServerURL:            strings.TrimRight(urlArg, "/"),
			APIKey:               keyArg,
			DeviceUUID:           "", // empty: first install, initDeviceIdentity uses the shared Obli* ID at once
			CheckIntervalSeconds: 60,
			AgentVersion:         agentVersion,
		}
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save config: %v", err)
		} else {
			log.Printf("First run: config saved to %s", configFile)
		}
	}

	// CLI flags override config file (useful for updates and for a manual
	// re-install with new credentials) — except values a 'reconfigure' command
	// explicitly replaced: on Windows the service arguments written by the MSI
	// still carry the old --url/--key until the next MSI run, and must not
	// revert the transfer.
	if urlArg != "" {
		u := strings.TrimRight(urlArg, "/")
		if u != cfg.ServerURL && containsString(cfg.SupersededServerURLs, u) {
			log.Printf("Ignoring --url %s: replaced by a reconfigure command (using %s)", u, cfg.ServerURL)
		} else {
			cfg.ServerURL = u
		}
	}
	if keyArg != "" {
		if keyArg != cfg.APIKey && containsString(cfg.SupersededAPIKeys, hashSecret(keyArg)) {
			log.Printf("Ignoring --key from the service arguments: replaced by a reconfigure command")
		} else {
			cfg.APIKey = keyArg
		}
	}

	// Shared Obli* device ID (identity v2). Until the
	// server acknowledged the shared Obli* device ID (identityV2), the ID is
	// re-resolved from hardware at every start by the legacy resolver — stable
	// across reinstalls, same algorithm as the other Obli* agents — and the
	// shared ID is announced to the server (X-Obli-Device-Id) until it acks.
	storedUUID, storedV2 := cfg.DeviceUUID, cfg.IdentityV2
	cur, shared := initDeviceIdentity(cfg.IdentityV2, storedUUID,
		func() string { return resolveDeviceUUID(storedUUID) },
		"obliview-agent/"+agentVersion,
		func(newID string) {
			// Server acknowledged the shared ID: persist it, then redial the
			// command channel under the new ?uuid=.
			cfg.DeviceUUID = newID
			cfg.IdentityV2 = true
			if err := saveConfig(cfg); err != nil {
				log.Printf("Warning: could not save config: %v", err)
			}
			closeActiveCmdWS()
		})
	cfg.DeviceUUID = cur
	if shared {
		cfg.IdentityV2 = true
	}
	identityChanged := cfg.DeviceUUID != storedUUID || cfg.IdentityV2 != storedV2
	if cfg.CheckIntervalSeconds == 0 {
		cfg.CheckIntervalSeconds = 60
	}
	if identityChanged && cfg.AgentVersion == agentVersion {
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save config: %v", err)
		}
	}
	// Always use the binary's built-in version (overrides stale config.json value).
	// Save back to disk so config.json stays accurate after an update.
	if cfg.AgentVersion != agentVersion {
		cfg.AgentVersion = agentVersion
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not update agentVersion in config: %v", err)
		} else {
			log.Printf("Agent version updated to %s in config", agentVersion)
		}
	}

	return cfg
}
