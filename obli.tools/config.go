package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AppEntry holds one registered application in Obli.tools.
type AppEntry struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Color   string `json:"color"`   // hex, e.g. "#6366f1"
	LastURL string `json:"lastUrl,omitempty"` // last-visited path, e.g. "/agents/5"
}

// Environment groups related applications under a user-chosen label.
// Each environment typically corresponds to one deployment (e.g. "Perso", "Taff").
type Environment struct {
	Name string     `json:"name"`
	Apps []AppEntry `json:"apps"`
}

// alertCache stores the last-known unread alert count per app URL.
// Updated each time the user visits an app; read by the tab bar JS to show badges.
var alertCache = map[string]int{}
var alertCacheMu sync.Mutex

// notifyThrottle prevents spamming OS notifications — one per origin per cooldown period.
var notifyThrottle = map[string]time.Time{}
var notifyThrottleMu sync.Mutex

const notifyCooldown = 30 * time.Second

// TabConfig holds the multi-tenant tab-cycling preferences for the desktop app.
// The two modes are independent and can both be active simultaneously:
//   - AutoCycle    : round-robin through all tenants every AutoCycleIntervalS seconds
//   - FollowAlerts : switch immediately to a tenant that receives a new unread alert
type TabConfig struct {
	AutoCycleEnabled           bool `json:"autoCycleEnabled"`
	AutoCycleIntervalS         int  `json:"autoCycleIntervalS"`         // seconds between automatic tenant switches
	FollowAlertsEnabled        bool `json:"followAlertsEnabled"`        // switch on new unread alert from another tenant
	NativeNotificationsEnabled bool `json:"nativeNotificationsEnabled"` // fire OS-native notifications on new alerts
}

// Config holds all persisted user preferences.
type Config struct {
	URL          string        `json:"url"`
	Apps         []AppEntry    `json:"apps,omitempty"`         // DEPRECATED — migrated to Environments on load
	Environments []Environment `json:"environments,omitempty"` // grouped app environments
	ActiveEnvIdx int           `json:"activeEnvIdx"`           // last active environment index
	Width        int           `json:"width,omitempty"`        // last known window content width  (logical px)
	Height       int           `json:"height,omitempty"`       // last known window content height (logical px)
	DownloadDir  string        `json:"downloadDir,omitempty"`  // preferred folder for native file downloads
	TabConfig    TabConfig     `json:"tabConfig"`              // multi-tenant tab-bar cycling settings
}

// AllApps returns a flat slice of all apps across all environments.
func (c *Config) AllApps() []AppEntry {
	n := 0
	for _, env := range c.Environments {
		n += len(env.Apps)
	}
	all := make([]AppEntry, 0, n)
	for _, env := range c.Environments {
		all = append(all, env.Apps...)
	}
	return all
}

// GlobalAppIndex converts an environment index + local app index to a global
// index into the AllApps() flat list.
func (c *Config) GlobalAppIndex(envIdx, localIdx int) int {
	idx := 0
	for i := 0; i < envIdx && i < len(c.Environments); i++ {
		idx += len(c.Environments[i].Apps)
	}
	return idx + localIdx
}

// EnvOfGlobalIdx returns (envIdx, localIdx) for a given global app index.
func (c *Config) EnvOfGlobalIdx(globalIdx int) (int, int) {
	offset := 0
	for i, env := range c.Environments {
		if globalIdx < offset+len(env.Apps) {
			return i, globalIdx - offset
		}
		offset += len(env.Apps)
	}
	return 0, 0
}

// ActiveEnv returns the currently active environment (safe bounds check).
func (c *Config) ActiveEnv() *Environment {
	if c.ActiveEnvIdx >= 0 && c.ActiveEnvIdx < len(c.Environments) {
		return &c.Environments[c.ActiveEnvIdx]
	}
	if len(c.Environments) > 0 {
		return &c.Environments[0]
	}
	return nil
}

// configPath returns the OS-appropriate path for config.json:
//   - Windows : %APPDATA%\ObliTools\config.json
//   - macOS   : ~/Library/Application Support/ObliTools/config.json
//   - Linux   : ~/.config/oblitools/config.json
func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ObliTools", "config.json"), nil
}

// loadConfig reads the config file and returns the parsed Config.
// Returns an empty Config (no error) when the file does not exist yet.
func loadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return &Config{}, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		// File not found on first run — not an error.
		return &Config{}, nil
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return &Config{}, nil
	}

	// Apply defaults for TabConfig
	if cfg.TabConfig.AutoCycleIntervalS <= 0 {
		cfg.TabConfig.AutoCycleIntervalS = 30
	}

	// ── Migration: flat Apps → single Environment ─────────────────────────
	// Existing configs had a flat Apps[] list. Migrate to Environments.
	if len(cfg.Apps) > 0 && len(cfg.Environments) == 0 {
		// Migrate: if URL is set but Apps is empty (very old), seed Apps from URL first.
		cfg.Environments = []Environment{{
			Name: "Default",
			Apps: cfg.Apps,
		}}
		cfg.Apps = nil // clear deprecated field
	}

	// Even older: URL set but nothing else.
	if cfg.URL != "" && len(cfg.Environments) == 0 {
		cfg.Environments = []Environment{{
			Name: "Default",
			Apps: []AppEntry{{
				Name:  "App",
				URL:   cfg.URL,
				Color: appColorFromURL(cfg.URL),
			}},
		}}
	}

	// Always recompute app colours from URL so stale or wrong stored values
	// are fixed automatically on every launch.
	for i := range cfg.Environments {
		for j := range cfg.Environments[i].Apps {
			cfg.Environments[i].Apps[j].Color = appColorFromURL(cfg.Environments[i].Apps[j].URL)
		}
	}

	// Bounds-check ActiveEnvIdx.
	if cfg.ActiveEnvIdx < 0 || cfg.ActiveEnvIdx >= len(cfg.Environments) {
		cfg.ActiveEnvIdx = 0
	}

	return &cfg, nil
}

// saveConfig persists the Config to disk.
func saveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0o600)
}
