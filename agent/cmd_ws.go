package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ── Timing constants ──────────────────────────────────────────────────────────

const (
	// cmdWSReadTimeout: maximum time to wait for any frame (message or server ping).
	// Server sends pings every 15 s, so 3 missed pings = 45 s; we use 60 s to give
	// one extra cycle before declaring the connection dead.
	cmdWSReadTimeout = 60 * time.Second

	// Reconnect backoff: starts at 2 s, grows ×1.5 each failure, caps at 60 s.
	cmdWSReconnectBase = 2 * time.Second
	cmdWSReconnectMax  = 60 * time.Second
)

// ── Message types ─────────────────────────────────────────────────────────────

// cmdHeartbeatMsg is the periodic status payload sent agent → server.
// Mirrors the old HTTP push body so the server can reuse agentService.handlePush.
type cmdHeartbeatMsg struct {
	Type         string  `json:"type"` // always "heartbeat"
	Hostname     string  `json:"hostname"`
	AgentVersion string  `json:"agentVersion"`
	AgentBuild   string  `json:"agentBuild"` // "modern" | "nt6" (build_flavor.go)
	OSInfo       OSInfo  `json:"osInfo"`
	Metrics      Metrics `json:"metrics"`
}

// cmdConfigMsg is the server's response to each heartbeat.
type cmdConfigMsg struct {
	Type                 string `json:"type"`                           // always "config"
	CheckIntervalSeconds int    `json:"checkIntervalSeconds,omitempty"` // agent push cadence
	LatestVersion        string `json:"latestVersion,omitempty"`        // legacy auto-update signal
	// AutoUpdate must be explicitly true for LatestVersion to be honoured
	// (servers running with AGENT_LEGACY_AUTO_UPDATE). Updates are otherwise
	// admin-driven through the 'update' command.
	AutoUpdate bool `json:"autoUpdate,omitempty"`
	// IdentityAck: device identity v2 — the server re-keyed this device under
	// the shared Obli* device ID announced on the dial (X-Obli-Device-Id).
	// The WS equivalent of the push's X-Obli-Device-Id-Ack header.
	IdentityAck string `json:"identityAck,omitempty"`
	serverCommandFields
}

// serverCommandFields is the one-shot command piggy-backed on a config
// message (WS) or a push response (legacy HTTP). See parseServerCommand for
// the accepted shapes.
type serverCommandFields struct {
	// "uninstall" | "update" | "reconfigure", a JSON object
	// {"type": "...", ...payload}, or that object JSON-encoded as a string
	// (e.g. the raw agent_devices.pending_command value).
	Command json.RawMessage `json:"command,omitempty"`
	// Optional payload next to a plain command name.
	CommandPayload map[string]interface{} `json:"commandPayload,omitempty"`
	// Flat payload fields, accepted as well.
	TargetVersion string `json:"targetVersion,omitempty"`
	APIKey        string `json:"apiKey,omitempty"`
	ServerURL     string `json:"serverUrl,omitempty"`
}

// serverCommand is a parsed one-shot command.
type serverCommand struct {
	Name          string
	TargetVersion string
	APIKey        string
	ServerURL     string
}

// payloadString returns the first non-empty string value among keys.
func payloadString(p map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := p[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// commandFromPayload builds a serverCommand from a name and a payload map.
func commandFromPayload(name string, p map[string]interface{}) serverCommand {
	return serverCommand{
		Name:          strings.ToLower(strings.TrimSpace(name)),
		TargetVersion: payloadString(p, "targetVersion", "target_version", "version"),
		APIKey:        payloadString(p, "apiKey", "api_key"),
		ServerURL:     payloadString(p, "serverUrl", "server_url"),
	}
}

// parseServerCommand decodes the command carried by a config message or a
// push response. Accepted shapes:
//
//	"command": "update", "commandPayload": {"targetVersion": "2.1.0"}
//	"command": "reconfigure", "apiKey": "…", "serverUrl": "…"   (flat fields)
//	"command": {"type": "reconfigure", "apiKey": "…", "serverUrl": "…"}
//	"command": {"type": "update", "payload": {"targetVersion": "2.1.0"}}
//	"command": "{\"type\":\"update\",\"targetVersion\":\"2.1.0\"}"  (JSON text)
//
// The object may name the command with "type", "commandType" or "command".
// ok is false when there is no command.
func parseServerCommand(f serverCommandFields) (serverCommand, bool) {
	raw := strings.TrimSpace(string(f.Command))
	if raw == "" || raw == "null" || raw == `""` {
		return serverCommand{}, false
	}

	var obj map[string]interface{}
	var name string
	if err := json.Unmarshal(f.Command, &name); err == nil {
		name = strings.TrimSpace(name)
		if strings.HasPrefix(name, "{") {
			_ = json.Unmarshal([]byte(name), &obj)
		}
	} else {
		_ = json.Unmarshal(f.Command, &obj)
	}

	if obj != nil {
		n := payloadString(obj, "type", "commandType", "command")
		merged := map[string]interface{}{}
		for k, v := range obj {
			merged[k] = v
		}
		if nested, ok := obj["payload"].(map[string]interface{}); ok {
			for k, v := range nested {
				merged[k] = v
			}
		}
		cmd := commandFromPayload(n, merged)
		if cmd.Name == "" {
			return serverCommand{}, false
		}
		return cmd, true
	}

	if name == "" {
		return serverCommand{}, false
	}
	p := map[string]interface{}{}
	for k, v := range f.CommandPayload {
		p[k] = v
	}
	if f.TargetVersion != "" {
		p["targetVersion"] = f.TargetVersion
	}
	if f.APIKey != "" {
		p["apiKey"] = f.APIKey
	}
	if f.ServerURL != "" {
		p["serverUrl"] = f.ServerURL
	}
	return commandFromPayload(name, p), true
}

// handleServerCommand executes a one-shot command received in a config
// message or a push response. Returns true when the command takes the agent
// down (uninstall), so the caller stops processing the message.
// Unknown commands are logged and ignored.
func handleServerCommand(cfg *Config, cmd serverCommand, source string) bool {
	log.Printf("%s: received command: %s", source, cmd.Name)
	switch cmd.Name {
	case "uninstall":
		handleUninstallCommand(cfg)
		return true // Unix exits; Windows waits for msiexec to stop the service
	case "update":
		// Background: the download never blocks the read loop.
		go applyRequestedUpdate(cfg, cmd.TargetVersion)
	case "reconfigure":
		_ = handleReconfigureCommand(cfg, reconfigureRequest{APIKey: cmd.APIKey, ServerURL: cmd.ServerURL})
	default:
		log.Printf("%s: unknown command %q — ignored", source, cmd.Name)
	}
	return false
}

// cmdCommandMsg is a server-pushed command (open_remote_tunnel, etc.).
type cmdCommandMsg struct {
	Type        string                 `json:"type"` // "command"
	ID          string                 `json:"id"`
	CommandType string                 `json:"commandType"`
	Payload     map[string]interface{} `json:"payload"`
}

// cmdAckMsg is sent by the agent to confirm command execution.
type cmdAckMsg struct {
	Type        string      `json:"type"` // "ack"
	ID          string      `json:"id"`
	CommandType string      `json:"commandType"`
	Success     bool        `json:"success"`
	Result      interface{} `json:"result,omitempty"`
	Error       string      `json:"error,omitempty"`
}

// ── Public entry point ────────────────────────────────────────────────────────

// runCmdWS replaces the old HTTP push loop. It opens a persistent WebSocket
// command channel to the server and reconnects with exponential backoff.
//
// Heartbeats are sent at the agent's configured checkIntervalSeconds cadence
// (default 60 s). Commands (open_remote_tunnel, uninstall, …) are delivered
// instantly by the server over the same connection; no polling required.
func runCmdWS(cfg *Config) {
	log.Printf("Obliview Agent v%s starting (WS mode, uuid=%s server=%s)",
		cfg.AgentVersion, currentDeviceUUID(), cfg.ServerURL)

	// Device identity v2: follow regenerations / clone detections of the
	// shared device ID (device_identity.go).
	go watchSharedIdentity(nil)

	// No unauthenticated startup version check: the server only advertises
	// latestVersion to approved devices, in the config reply to the immediate
	// first heartbeat of each session. Pending, refused and suspended devices
	// therefore never self-update.

	backoff := cmdWSReconnectBase

	for {
		err := cmdWSSession(cfg)
		// Stop all proxy monitors when the WS session ends — they'll be
		// re-synced on the next successful connection.
		stopAllProxyRunners()
		if err == nil {
			// Clean server-side close — reconnect quickly.
			log.Printf("Command WS: clean close — reconnecting in %s", cmdWSReconnectBase)
			backoff = cmdWSReconnectBase
		} else {
			log.Printf("Command WS: %v — reconnecting in %s", err, backoff)
			next := time.Duration(float64(backoff) * 1.5)
			if next > cmdWSReconnectMax {
				next = cmdWSReconnectMax
			}
			backoff = next
		}
		time.Sleep(backoff)
	}
}

// activeCmdWS is the open command channel, so a reconfigure can drop it and
// let runCmdWS reconnect with the new credentials.
var (
	activeCmdWSMu sync.Mutex
	activeCmdWS   *wsConn
)

func setActiveCmdWS(ws *wsConn) {
	activeCmdWSMu.Lock()
	activeCmdWS = ws
	activeCmdWSMu.Unlock()
}

// closeActiveCmdWS closes the current command channel (if any); runCmdWS then
// reconnects using the in-memory config.
func closeActiveCmdWS() {
	activeCmdWSMu.Lock()
	ws := activeCmdWS
	activeCmdWSMu.Unlock()
	if ws != nil {
		// Close the socket only: writing a close frame here would race the
		// session's own writes. The read loop fails and the session ends.
		_ = ws.conn.Close()
	}
}

// pendingIdentityTarget returns the shared device ID awaiting the server's
// ack ("" when none), as announced by applyIdentityHeaders.
func pendingIdentityTarget() string {
	h := http.Header{}
	applyIdentityHeaders(h)
	return h.Get(IdentityHeaderTarget)
}

// ── Session ───────────────────────────────────────────────────────────────────

func cmdWSSession(cfg *Config) error {
	// Build ws(s):// URL for the agent command channel.
	base := strings.TrimRight(cfg.ServerURL, "/")
	var wsBase string
	switch {
	case strings.HasPrefix(base, "https://"):
		wsBase = "wss://" + base[8:]
	case strings.HasPrefix(base, "http://"):
		wsBase = "ws://" + base[7:]
	default:
		wsBase = base
	}
	wsURL := wsBase + "/api/agent/ws?uuid=" + url.QueryEscape(currentDeviceUUID())

	wsHeaders := http.Header{"X-API-Key": []string{cfg.APIKey}}
	// Identity v2: while a switch to the shared device ID is pending, announce
	// it (the heartbeat on this channel is the agent's push).
	applyIdentityHeaders(wsHeaders)
	dialledIdentityTarget := wsHeaders.Get(IdentityHeaderTarget)
	ws, err := wsConnect(wsURL, wsHeaders)
	if err != nil {
		return fmt.Errorf("connect %s: %w", wsBase, err)
	}
	defer ws.Close()
	setActiveCmdWS(ws)
	defer setActiveCmdWS(nil)

	log.Printf("Command WS: connected to %s", wsBase)

	// Send the first heartbeat immediately — registers/updates the device record
	// in the DB and receives the current resolved config + any offline-queued command.
	if err := sendCmdHeartbeat(ws, cfg); err != nil {
		return fmt.Errorf("initial heartbeat: %w", err)
	}

	// Variable-interval heartbeat: use a timer (not ticker) so we can
	// update the period on-the-fly when the server sends a new checkIntervalSeconds.
	hbTimer := time.NewTimer(time.Duration(cfg.CheckIntervalSeconds) * time.Second)
	defer hbTimer.Stop()

	// Set initial read deadline; reset on every received frame.
	if err := ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}

	// Read frames in a background goroutine.
	type wsFrame struct {
		opcode  byte
		payload []byte
		err     error
	}
	frameCh := make(chan wsFrame, 8)
	go func() {
		for {
			op, pay, err := ws.ReadFrame()
			frameCh <- wsFrame{op, pay, err}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {

		// ── Periodic heartbeat ─────────────────────────────────────────────────
		case <-hbTimer.C:
			// Identity v2: the shared ID changed during this session (regen
			// script, clone detected by another agent — watchSharedIdentity).
			// The claim only travels on the dial: redial to announce it.
			if t := pendingIdentityTarget(); t != "" && t != dialledIdentityTarget {
				log.Printf("Command WS: device identity switch to %s pending — reconnecting to announce it", t)
				return nil
			}
			if err := sendCmdHeartbeat(ws, cfg); err != nil {
				return fmt.Errorf("heartbeat send: %w", err)
			}
			hbTimer.Reset(time.Duration(cfg.CheckIntervalSeconds) * time.Second)

		// ── Incoming frame ─────────────────────────────────────────────────────
		case f := <-frameCh:
			if f.err != nil {
				return fmt.Errorf("read: %w", f.err)
			}

			// Any received frame resets the inactivity deadline.
			_ = ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout))

			switch f.opcode {
			case 0x8: // close — server-initiated graceful close
				return nil

			case 0x9: // ping from server — reply with pong
				_ = ws.SendPong(f.payload)

			case 0xA: // pong — ignore

			case 0x1: // text frame — JSON from server
				handleCmdWSFrame(cfg, ws, f.payload, hbTimer)
			}
		}
	}
}

// handleCmdWSFrame dispatches a text frame received from the server.
func handleCmdWSFrame(cfg *Config, ws *wsConn, payload []byte, hbTimer *time.Timer) {
	// Peek at the "type" field to route.
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		log.Printf("Command WS: malformed JSON: %v", err)
		return
	}

	switch env.Type {
	case "config":
		var msg cmdConfigMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed config message: %v", err)
			return
		}
		handleConfigMsg(cfg, msg, hbTimer)

	case "proxy_sync":
		var msg proxySyncMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed proxy_sync message: %v", err)
			return
		}
		handleProxySync(ws, msg.Monitors)

	case "command":
		var msg cmdCommandMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed command message: %v", err)
			return
		}
		// Execute asynchronously so the read loop is never blocked by a
		// long-running command (e.g. VNC tunnel setup).
		go handleWSCommand(cfg, ws, &msg)
	}
}

// handleConfigMsg applies the config response sent by the server after each heartbeat.
func handleConfigMsg(cfg *Config, msg cmdConfigMsg, hbTimer *time.Timer) {
	// One-shot command (process before version check since "uninstall" calls os.Exit).
	if cmd, ok := parseServerCommand(msg.serverCommandFields); ok {
		if handleServerCommand(cfg, cmd, "Command WS") {
			return
		}
	}

	// Update heartbeat interval if the server changed it.
	if msg.CheckIntervalSeconds > 0 && msg.CheckIntervalSeconds != cfg.CheckIntervalSeconds {
		cfg.CheckIntervalSeconds = msg.CheckIntervalSeconds
		_ = saveConfig(cfg)
		log.Printf("Command WS: check interval updated to %ds", cfg.CheckIntervalSeconds)
		// Reset timer to use the new interval immediately.
		hbTimer.Reset(time.Duration(cfg.CheckIntervalSeconds) * time.Second)
	}

	// Legacy piggy-backed version info — honoured only when the server
	// explicitly asks for it (autoUpdate:true, AGENT_LEGACY_AUTO_UPDATE). Runs
	// in the background so the download + verification never blocks this read
	// loop; applyUpdateIfNewer itself guarantees a single attempt at a time and
	// spaces retries.
	if msg.LatestVersion != "" && msg.AutoUpdate {
		go applyUpdateIfNewer(cfg, msg.LatestVersion)
	}

	// Identity v2: the server re-keyed this device under the shared ID. Last,
	// because the switch closes this channel (onSwitch in setupConfig) and
	// runCmdWS redials under the new ?uuid=.
	if msg.IdentityAck != "" {
		acceptIdentityAck(msg.IdentityAck)
	}
}

// handleWSCommand executes a structured server command and sends an ack.
func handleWSCommand(cfg *Config, ws *wsConn, msg *cmdCommandMsg) {
	log.Printf("Command WS: received command type=%s id=%s", msg.CommandType, msg.ID)

	var result interface{}
	var errMsg string

	switch msg.CommandType {
	case "proxy_check":
		result, errMsg = handleProxyCheck(msg.Payload)
	case "update":
		target := commandFromPayload(msg.CommandType, msg.Payload).TargetVersion
		if target != "" && strings.TrimPrefix(target, "v") == strings.TrimPrefix(agentVersion, "v") {
			result = map[string]string{"message": "already running v" + agentVersion}
			break
		}
		// Start after the ack is sent: on Windows msiexec stops this service.
		go func() {
			time.Sleep(500 * time.Millisecond)
			applyRequestedUpdate(cfg, target)
		}()
		result = map[string]string{"message": "update started", "currentVersion": agentVersion}
	case "reconfigure":
		cmd := commandFromPayload(msg.CommandType, msg.Payload)
		// Persists synchronously (an invalid request is reported in the ack);
		// the restart is delayed so the ack reaches the server first.
		if err := handleReconfigureCommand(cfg, reconfigureRequest{APIKey: cmd.APIKey, ServerURL: cmd.ServerURL}); err != nil {
			errMsg = err.Error()
		} else {
			result = map[string]string{"message": "reconfigured"}
		}
	case "uninstall":
		go func() {
			time.Sleep(500 * time.Millisecond)
			handleUninstallCommand(cfg)
		}()
		result = map[string]string{"message": "uninstall started"}
	default:
		errMsg = fmt.Sprintf("unsupported command type: %s", msg.CommandType)
		log.Printf("Command WS: %s", errMsg)
	}

	ack := cmdAckMsg{
		Type:        "ack",
		ID:          msg.ID,
		CommandType: msg.CommandType,
		Success:     errMsg == "",
		Result:      result,
		Error:       errMsg,
	}

	data, err := json.Marshal(ack)
	if err != nil {
		log.Printf("Command WS: ack marshal error: %v", err)
		return
	}
	if err := ws.WriteFrame(0x1, data); err != nil {
		log.Printf("Command WS: ack send error: %v", err)
	}
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

func sendCmdHeartbeat(ws *wsConn, cfg *Config) error {
	hostname, _ := os.Hostname()
	msg := cmdHeartbeatMsg{
		Type:         "heartbeat",
		Hostname:     hostname,
		AgentVersion: cfg.AgentVersion,
		AgentBuild:   agentBuildName(),
		OSInfo:       getOSInfo(),
		Metrics:      collectMetrics(),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	return ws.WriteFrame(0x1, data)
}
