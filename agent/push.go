package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

type pushBody struct {
	Hostname     string  `json:"hostname"`
	AgentVersion string  `json:"agentVersion"`
	AgentBuild   string  `json:"agentBuild"` // "modern" | "nt6" (build_flavor.go)
	OSInfo       OSInfo  `json:"osInfo"`
	Metrics      Metrics `json:"metrics"`
}

type pushResponse struct {
	Status        string `json:"status"`
	LatestVersion string `json:"latestVersion,omitempty"` // legacy piggybacked version info
	// AutoUpdate must be explicitly true for LatestVersion to be honoured
	// (servers running with AGENT_LEGACY_AUTO_UPDATE).
	AutoUpdate bool `json:"autoUpdate,omitempty"`
	Config     *struct {
		CheckIntervalSeconds int `json:"checkIntervalSeconds"`
	} `json:"config,omitempty"`
	// One-shot command from the server ('uninstall', 'update', 'reconfigure').
	// Cleared in DB once delivered. Same shapes as on the WS config message
	// (parseServerCommand in cmd_ws.go).
	serverCommandFields
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func push(cfg *Config) {
	hostname, _ := os.Hostname()

	body := pushBody{
		Hostname:     hostname,
		AgentVersion: cfg.AgentVersion,
		AgentBuild:   agentBuildName(),
		OSInfo:       getOSInfo(),
		Metrics:      collectMetrics(),
	}

	data, err := json.Marshal(body)
	if err != nil {
		log.Printf("Push error (marshal): %v", err)
		return
	}

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/agent/push", bytes.NewReader(data))
	if err != nil {
		log.Printf("Push error (request): %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)
	req.Header.Set("X-Device-UUID", currentDeviceUUID())
	applyIdentityHeaders(req.Header)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("Push error: %v", err)
		return
	}
	defer resp.Body.Close()

	// Identity v2: the server re-keyed this device under the shared ID
	// (registered — 202 pending — or known — 200).
	if resp.StatusCode == 200 || resp.StatusCode == 202 {
		handleIdentityAck(resp)
	}

	var result pushResponse
	_ = json.NewDecoder(resp.Body).Decode(&result)

	switch resp.StatusCode {
	case 200:
		backoffLevel = 0
		cfg.BackoffUntil = 0
		if result.Config != nil && result.Config.CheckIntervalSeconds > 0 &&
			result.Config.CheckIntervalSeconds != cfg.CheckIntervalSeconds {
			cfg.CheckIntervalSeconds = result.Config.CheckIntervalSeconds
			_ = saveConfig(cfg)
			log.Printf("Check interval updated to %ds", cfg.CheckIntervalSeconds)
		}
		log.Printf("Push OK")
		// Handle one-shot command from server — must be processed before the
		// version check since commands like "uninstall" call os.Exit.
		if cmd, ok := parseServerCommand(result.serverCommandFields); ok {
			if handleServerCommand(cfg, cmd, "Push") {
				return
			}
		}
		// Legacy piggybacked version — only when the server explicitly asks.
		if result.LatestVersion != "" && result.AutoUpdate {
			applyUpdateIfNewer(cfg, result.LatestVersion)
		}

	case 202:
		log.Printf("Device pending approval...")
		if result.Config != nil && result.Config.CheckIntervalSeconds > 0 {
			cfg.CheckIntervalSeconds = result.Config.CheckIntervalSeconds
			_ = saveConfig(cfg)
		}
		// Handle one-shot command (pending devices can also receive commands).
		if cmd, ok := parseServerCommand(result.serverCommandFields); ok {
			if handleServerCommand(cfg, cmd, "Push") {
				return
			}
		}
		if result.LatestVersion != "" && result.AutoUpdate {
			applyUpdateIfNewer(cfg, result.LatestVersion)
		}

	case 401:
		idx := backoffLevel
		if idx >= len(backoffSteps) {
			idx = len(backoffSteps) - 1
		}
		backoffSecs := backoffSteps[idx]
		log.Printf("Unauthorized. Backing off for %ds...", backoffSecs)
		backoffLevel++
		cfg.BackoffUntil = time.Now().UnixMilli() + int64(backoffSecs)*1000
		_ = saveConfig(cfg)

	case 409:
		log.Printf("Push rejected (HTTP 409): this device is registered in another workspace — waiting for a reconfigure or a re-install with that workspace's key")

	default:
		log.Printf("Push returned unexpected status %d", resp.StatusCode)
	}
}
