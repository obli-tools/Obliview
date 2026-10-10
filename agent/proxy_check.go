package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Types ────────────────────────────────────────────────────────────────────

// proxySyncMsg is sent by the server to tell this agent which monitors to
// check autonomously. Replaces any previously synced set.
type proxySyncMsg struct {
	Type     string              `json:"type"` // "proxy_sync"
	Monitors []proxyMonitorConfig `json:"monitors"`
}

// proxyMonitorConfig describes a single monitor the agent should check.
type proxyMonitorConfig struct {
	MonitorID           int                    `json:"monitorId"`
	Type                string                 `json:"type"`
	IntervalSeconds     int                    `json:"intervalSeconds"`
	TimeoutMs           int                    `json:"timeoutMs"`
	URL                 string                 `json:"url,omitempty"`
	Method              string                 `json:"method,omitempty"`
	Headers             map[string]interface{} `json:"headers,omitempty"`
	Body                string                 `json:"body,omitempty"`
	ExpectedStatusCodes []int                  `json:"expectedStatusCodes,omitempty"`
	Keyword             string                 `json:"keyword,omitempty"`
	KeywordIsPresent    bool                   `json:"keywordIsPresent,omitempty"`
	IgnoreSsl           bool                   `json:"ignoreSsl,omitempty"`
	JsonPath            string                 `json:"jsonPath,omitempty"`
	JsonExpectedValue   string                 `json:"jsonExpectedValue,omitempty"`
	Hostname            string                 `json:"hostname,omitempty"`
	Port                int                    `json:"port,omitempty"`
	DnsRecordType       string                 `json:"dnsRecordType,omitempty"`
	DnsResolver         string                 `json:"dnsResolver,omitempty"`
	DnsExpectedValue    string                 `json:"dnsExpectedValue,omitempty"`
	SslWarnDays         int                    `json:"sslWarnDays,omitempty"`
	SmtpHost            string                 `json:"smtpHost,omitempty"`
	SmtpPort            int                    `json:"smtpPort,omitempty"`
	GameType            string                 `json:"gameType,omitempty"`
	GameHost            string                 `json:"gameHost,omitempty"`
	GamePort            int                    `json:"gamePort,omitempty"`
}

// proxyCheckResult mirrors the server's CheckResult interface.
type proxyCheckResult struct {
	Status       string  `json:"status"`
	ResponseTime float64 `json:"responseTime,omitempty"`
	StatusCode   int     `json:"statusCode,omitempty"`
	Message      string  `json:"message,omitempty"`
	Ping         float64 `json:"ping,omitempty"`
	Value        string  `json:"value,omitempty"`
}

// proxyResultMsg is pushed from agent → server for each completed check.
type proxyResultMsg struct {
	Type      string           `json:"type"` // "proxy_result"
	MonitorID int              `json:"monitorId"`
	Result    proxyCheckResult `json:"result"`
}

// ── Scheduler ────────────────────────────────────────────────────────────────

// proxyRunner manages a single monitor's autonomous check loop.
type proxyRunner struct {
	config proxyMonitorConfig
	ws     *wsConn
	cancel context.CancelFunc
}

var (
	proxyMu      sync.Mutex
	proxyRunners = map[int]*proxyRunner{} // monitorId → runner
)

// handleProxySync is called when the server sends a proxy_sync message.
// It reconciles the running set of proxy monitors: stops removed ones,
// starts new ones, and updates changed ones.
func handleProxySync(ws *wsConn, monitors []proxyMonitorConfig) {
	proxyMu.Lock()
	defer proxyMu.Unlock()

	desired := make(map[int]proxyMonitorConfig, len(monitors))
	for _, m := range monitors {
		desired[m.MonitorID] = m
	}

	// Stop runners that are no longer in the desired set.
	for id, runner := range proxyRunners {
		if _, ok := desired[id]; !ok {
			log.Printf("Proxy: stopping monitor %d (removed)", id)
			runner.cancel()
			delete(proxyRunners, id)
		}
	}

	// Start or update runners.
	for id, cfg := range desired {
		if existing, ok := proxyRunners[id]; ok {
			// Config may have changed — restart if so.
			if !proxyConfigEqual(existing.config, cfg) {
				log.Printf("Proxy: restarting monitor %d (config changed)", id)
				existing.cancel()
				delete(proxyRunners, id)
			} else {
				continue // already running with same config
			}
		}

		log.Printf("Proxy: starting monitor %d (type=%s, interval=%ds)", id, cfg.Type, cfg.IntervalSeconds)
		ctx, cancel := context.WithCancel(context.Background())
		runner := &proxyRunner{config: cfg, ws: ws, cancel: cancel}
		proxyRunners[id] = runner
		go runner.run(ctx)
	}

	log.Printf("Proxy: %d monitor(s) active", len(proxyRunners))
}

// stopAllProxyRunners stops all running proxy monitors. Called on WS disconnect.
func stopAllProxyRunners() {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	for id, runner := range proxyRunners {
		runner.cancel()
		delete(proxyRunners, id)
	}
	log.Printf("Proxy: all monitors stopped (WS disconnected)")
}

func proxyConfigEqual(a, b proxyMonitorConfig) bool {
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}

// run is the autonomous check loop for a single proxy monitor.
func (r *proxyRunner) run(ctx context.Context) {
	// Run the first check immediately, then on the configured interval.
	r.executeAndPush()

	interval := time.Duration(r.config.IntervalSeconds) * time.Second
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.executeAndPush()
		}
	}
}

func (r *proxyRunner) executeAndPush() {
	timeout := time.Duration(r.config.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	payload := configToPayload(r.config)
	result := executeCheck(r.config.Type, payload, timeout)

	msg := proxyResultMsg{
		Type:      "proxy_result",
		MonitorID: r.config.MonitorID,
		Result:    result,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Proxy: marshal error for monitor %d: %v", r.config.MonitorID, err)
		return
	}
	if err := r.ws.WriteFrame(0x1, data); err != nil {
		log.Printf("Proxy: send error for monitor %d: %v", r.config.MonitorID, err)
	}
}

func configToPayload(c proxyMonitorConfig) map[string]interface{} {
	// Convert the typed config to a generic map for the check functions.
	data, _ := json.Marshal(c)
	var m map[string]interface{}
	_ = json.Unmarshal(data, &m)
	return m
}

// handleProxyCheck handles one-shot proxy_check commands (legacy/fallback).
func handleProxyCheck(payload map[string]interface{}) (interface{}, string) {
	checkType, _ := payload["type"].(string)
	timeout := getPayloadDuration(payload, "timeoutMs", 10*time.Second)
	result := executeCheck(checkType, payload, timeout)
	return result, ""
}

// ── Check dispatcher ─────────────────────────────────────────────────────────

func executeCheck(checkType string, payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	switch checkType {
	case "http", "json_api":
		return doHTTPCheck(payload, timeout)
	case "ping":
		return doPingCheck(payload, timeout)
	case "tcp":
		return doTCPCheck(payload, timeout)
	case "dns":
		return doDNSCheck(payload, timeout)
	case "ssl":
		return doSSLCheck(payload, timeout)
	case "smtp":
		return doSMTPCheck(payload, timeout)
	default:
		return proxyCheckResult{Status: "down", Message: fmt.Sprintf("unsupported monitor type: %s", checkType)}
	}
}

// ── HTTP / JSON API ──────────────────────────────────────────────────────────

func doHTTPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	url, _ := payload["url"].(string)
	if url == "" {
		return proxyCheckResult{Status: "down", Message: "no URL provided"}
	}

	method, _ := payload["method"].(string)
	if method == "" {
		method = "GET"
	}

	ignoreSsl, _ := payload["ignoreSsl"].(bool)

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: ignoreSsl},
	}
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	var bodyReader io.Reader
	if body, ok := payload["body"].(string); ok && body != "" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return proxyCheckResult{Status: "down", Message: err.Error()}
	}

	if headers, ok := payload["headers"].(map[string]interface{}); ok {
		for k, v := range headers {
			if sv, ok := v.(string); ok {
				req.Header.Set(k, sv)
			}
		}
	}

	start := time.Now()
	resp, err := client.Do(req)
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	bodyStr := string(bodyBytes)

	result := proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		StatusCode:   resp.StatusCode,
		Message:      fmt.Sprintf("%d %s", resp.StatusCode, http.StatusText(resp.StatusCode)),
	}

	if codes := getPayloadIntSlice(payload, "expectedStatusCodes"); len(codes) > 0 {
		found := false
		for _, c := range codes {
			if c == resp.StatusCode {
				found = true
				break
			}
		}
		if !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Status %d not in expected codes", resp.StatusCode)
			return result
		}
	} else {
		if resp.StatusCode < 200 || resp.StatusCode >= 400 {
			result.Status = "down"
			return result
		}
	}

	if keyword, _ := payload["keyword"].(string); keyword != "" {
		isPresent, _ := payload["keywordIsPresent"].(bool)
		found := strings.Contains(bodyStr, keyword)
		if isPresent && !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Keyword '%s' not found in response", keyword)
		} else if !isPresent && found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Keyword '%s' found in response (should be absent)", keyword)
		}
	}

	if jsonPath, _ := payload["jsonPath"].(string); jsonPath != "" {
		val := extractJSONPath(bodyStr, jsonPath)
		result.Value = val
		if expected, _ := payload["jsonExpectedValue"].(string); expected != "" {
			if val != expected {
				result.Status = "down"
				result.Message = fmt.Sprintf("JSON path %s: got %q, expected %q", jsonPath, val, expected)
			}
		}
	}

	if strings.HasPrefix(url, "https://") && !ignoreSsl && resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
		warnDays := getPayloadInt(payload, "sslWarnDays", 30)

		if daysUntilExpiry <= 0 {
			result.Status = "down"
			result.Message = fmt.Sprintf("SSL certificate expired %d days ago", -daysUntilExpiry)
		} else if daysUntilExpiry <= warnDays {
			result.Status = "up"
			result.Message = fmt.Sprintf("SSL certificate expires in %d days", daysUntilExpiry)
		}
	}

	return result
}

// ── Ping ─────────────────────────────────────────────────────────────────────

func doPingCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	timeoutSec := int(timeout.Seconds())
	if timeoutSec < 1 {
		timeoutSec = 5
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "1", "-w", fmt.Sprintf("%d", timeoutSec*1000), hostname)
	} else {
		cmd = exec.Command("ping", "-c", "1", "-W", fmt.Sprintf("%d", timeoutSec), hostname)
	}

	start := time.Now()
	out, err := cmd.CombinedOutput()
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "Host unreachable"}
	}

	outStr := string(out)
	ping := extractPingTime(outStr)

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Ping:         ping,
		Message:      fmt.Sprintf("Alive (%.1fms)", ping),
	}
}

var pingTimeRe = regexp.MustCompile(`(?:time[=<]|=)\s*([\d.]+)\s*ms`)

func extractPingTime(output string) float64 {
	m := pingTimeRe.FindStringSubmatch(output)
	if m == nil {
		return 0
	}
	var v float64
	fmt.Sscanf(m[1], "%f", &v)
	return v
}

// ── TCP ──────────────────────────────────────────────────────────────────────

func doTCPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	port := getPayloadInt(payload, "port", 0)
	if hostname == "" || port == 0 {
		return proxyCheckResult{Status: "down", Message: "hostname and port required"}
	}

	addr := net.JoinHostPort(strings.Trim(hostname, "[]"), strconv.Itoa(port))
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, timeout)
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	conn.Close()

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      fmt.Sprintf("TCP %s open", addr),
	}
}

// ── DNS ──────────────────────────────────────────────────────────────────────

func doDNSCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	resolver := net.DefaultResolver
	if dnsResolver, _ := payload["dnsResolver"].(string); dnsResolver != "" {
		if !strings.Contains(dnsResolver, ":") {
			dnsResolver += ":53"
		}
		resolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: timeout}
				return d.DialContext(ctx, "udp", dnsResolver)
			},
		}
	}

	start := time.Now()

	recordType, _ := payload["dnsRecordType"].(string)
	if recordType == "" {
		recordType = "A"
	}

	var records []string
	var err error

	switch recordType {
	case "A", "AAAA":
		records, err = resolver.LookupHost(context.Background(), hostname)
	case "MX":
		var mxs []*net.MX
		mxs, err = resolver.LookupMX(context.Background(), hostname)
		for _, mx := range mxs {
			records = append(records, fmt.Sprintf("%s (priority %d)", mx.Host, mx.Pref))
		}
	case "CNAME":
		var cname string
		cname, err = resolver.LookupCNAME(context.Background(), hostname)
		if cname != "" {
			records = []string{cname}
		}
	case "TXT":
		records, err = resolver.LookupTXT(context.Background(), hostname)
	case "NS":
		var nss []*net.NS
		nss, err = resolver.LookupNS(context.Background(), hostname)
		for _, ns := range nss {
			records = append(records, ns.Host)
		}
	default:
		records, err = resolver.LookupHost(context.Background(), hostname)
	}

	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	if len(records) == 0 {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "No records found"}
	}

	result := proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      strings.Join(records, ", "),
	}

	if expected, _ := payload["dnsExpectedValue"].(string); expected != "" {
		found := false
		for _, r := range records {
			if strings.TrimSuffix(r, ".") == strings.TrimSuffix(expected, ".") {
				found = true
				break
			}
		}
		if !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Expected %q not found in %s", expected, result.Message)
		}
	}

	return result
}

// ── SSL ──────────────────────────────────────────────────────────────────────

func doSSLCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	port := getPayloadInt(payload, "port", 443)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	addr := fmt.Sprintf("%s:%d", hostname, port)
	start := time.Now()

	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", addr, &tls.Config{
		ServerName: hostname,
	})
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer conn.Close()

	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "No certificate presented"}
	}

	cert := certs[0]
	daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
	warnDays := getPayloadInt(payload, "sslWarnDays", 30)

	if daysUntilExpiry <= 0 {
		return proxyCheckResult{
			Status:       "down",
			ResponseTime: responseTime,
			Message:      fmt.Sprintf("SSL certificate expired %d days ago (subject: %s)", -daysUntilExpiry, cert.Subject.CommonName),
		}
	}

	msg := fmt.Sprintf("SSL valid, expires in %d days (subject: %s, issuer: %s)", daysUntilExpiry, cert.Subject.CommonName, cert.Issuer.CommonName)
	if daysUntilExpiry <= warnDays {
		msg = fmt.Sprintf("SSL certificate expires in %d days (subject: %s)", daysUntilExpiry, cert.Subject.CommonName)
	}

	return proxyCheckResult{Status: "up", ResponseTime: responseTime, Message: msg}
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

func doSMTPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	host, _ := payload["smtpHost"].(string)
	if host == "" {
		host, _ = payload["hostname"].(string)
	}
	port := getPayloadInt(payload, "smtpPort", 25)
	if host == "" {
		return proxyCheckResult{Status: "down", Message: "no SMTP host provided"}
	}

	addr := net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
	start := time.Now()

	conn, err := net.DialTimeout("tcp", addr, timeout)
	responseTime := float64(time.Since(start).Milliseconds())
	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "Failed to read SMTP banner"}
	}

	banner := strings.TrimSpace(string(buf[:n]))
	if !strings.HasPrefix(banner, "220") {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: fmt.Sprintf("SMTP banner: %s", banner)}
	}

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      banner,
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func getPayloadInt(p map[string]interface{}, key string, def int) int {
	if v, ok := p[key].(float64); ok {
		return int(v)
	}
	return def
}

func getPayloadDuration(p map[string]interface{}, key string, def time.Duration) time.Duration {
	if v, ok := p[key].(float64); ok && v > 0 {
		return time.Duration(v) * time.Millisecond
	}
	return def
}

func getPayloadIntSlice(p map[string]interface{}, key string) []int {
	arr, ok := p[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]int, 0, len(arr))
	for _, v := range arr {
		if f, ok := v.(float64); ok {
			out = append(out, int(f))
		}
	}
	return out
}

func extractJSONPath(body, path string) string {
	var data interface{}
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		return ""
	}

	parts := strings.Split(path, ".")
	current := data

	for _, part := range parts {
		if idx := strings.Index(part, "["); idx >= 0 {
			key := part[:idx]
			idxStr := part[idx+1 : len(part)-1]
			var arrIdx int
			fmt.Sscanf(idxStr, "%d", &arrIdx)

			if m, ok := current.(map[string]interface{}); ok {
				current = m[key]
			} else {
				return ""
			}
			if arr, ok := current.([]interface{}); ok && arrIdx < len(arr) {
				current = arr[arrIdx]
			} else {
				return ""
			}
		} else {
			if m, ok := current.(map[string]interface{}); ok {
				current = m[part]
			} else {
				return ""
			}
		}
	}

	if current == nil {
		return ""
	}
	return fmt.Sprintf("%v", current)
}
