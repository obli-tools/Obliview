// Obliview Install Wizard
//
// Self-contained .exe that embeds the latest obliview-agent.msi at build time
// and is pre-filled with a server URL + API key via a tail config blob appended
// by the server's /api/agent/installer/wizard.exe endpoint.
//
// Tail blob layout: [json {serverUrl, apiKey}][magic "OBLI_CFG" 8B][uint32 LE length]
//
// Operator flow:
//   1. Admin downloads the wizard from the Obliview UI (per-key handoff).
//   2. Operator runs the .exe on the target host (UAC prompt on msiexec only).
//   3. Wizard pre-fills the URL + key fields — operator can edit before install.
//   4. Install button: extract MSI to %TEMP%, run msiexec /i with SERVERURL + APIKEY.
//   5. Live log streams msiexec output to a read-only text area.
//
// Build (from agent/ on Windows):
//   done by the release pipeline (embeds the real MSI first)
package main

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
)

//go:embed obliview-agent.msi
var embeddedMsi []byte

// version is injected at build time via -ldflags="-X main.version=<v>".
var version = "dev"

const (
	configMagic   = "OBLI_CFG"
	configMaxSize = 1 * 1024 * 1024 // 1 MB sanity cap
)

type embeddedConfig struct {
	ServerURL string `json:"serverUrl"`
	APIKey    string `json:"apiKey"`
}

// readEmbeddedConfig reads the tail blob from the current executable.
// Layout (parsed from end of file):
//   [json bytes][magic "OBLI_CFG" 8B][uint32 LE length]
// Returns zero-value struct if the wizard wasn't customised by the server.
func readEmbeddedConfig() embeddedConfig {
	exePath, err := os.Executable()
	if err != nil {
		return embeddedConfig{}
	}
	f, err := os.Open(exePath)
	if err != nil {
		return embeddedConfig{}
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil || stat.Size() < int64(len(configMagic)+4) {
		return embeddedConfig{}
	}

	// Read trailing 12 bytes: 8B magic + 4B length
	trailer := make([]byte, len(configMagic)+4)
	if _, err := f.ReadAt(trailer, stat.Size()-int64(len(trailer))); err != nil {
		return embeddedConfig{}
	}
	if string(trailer[:len(configMagic)]) != configMagic {
		return embeddedConfig{}
	}
	cfgLen := binary.LittleEndian.Uint32(trailer[len(configMagic):])
	if cfgLen == 0 || cfgLen > configMaxSize {
		return embeddedConfig{}
	}

	cfgBuf := make([]byte, cfgLen)
	off := stat.Size() - int64(len(trailer)) - int64(cfgLen)
	if off < 0 {
		return embeddedConfig{}
	}
	if _, err := f.ReadAt(cfgBuf, off); err != nil {
		return embeddedConfig{}
	}

	var cfg embeddedConfig
	if err := json.Unmarshal(cfgBuf, &cfg); err != nil {
		return embeddedConfig{}
	}
	return cfg
}

// ── UI state ──────────────────────────────────────────────────────────────────

var (
	mw          *walk.MainWindow
	serverEdit  *walk.LineEdit
	apiKeyEdit  *walk.LineEdit
	logEdit     *walk.TextEdit
	installBtn  *walk.PushButton
	logMu       sync.Mutex
)

func appendLog(line string) {
	logMu.Lock()
	defer logMu.Unlock()
	if logEdit == nil {
		return
	}
	mw.Synchronize(func() {
		logEdit.AppendText(line + "\r\n")
	})
}

func runInstall() {
	server := serverEdit.Text()
	apiKey := apiKeyEdit.Text()
	if server == "" || apiKey == "" {
		walk.MsgBox(mw, "Missing input", "Server URL and API key are both required.", walk.MsgBoxIconWarning)
		return
	}
	installBtn.SetEnabled(false)
	defer installBtn.SetEnabled(true)

	tmpDir := os.TempDir()
	msiPath := filepath.Join(tmpDir, "obliview-agent.msi")
	appendLog(fmt.Sprintf("Extracting MSI to %s ...", msiPath))
	if err := os.WriteFile(msiPath, embeddedMsi, 0644); err != nil {
		appendLog("ERROR: " + err.Error())
		return
	}

	appendLog("Running msiexec ...")
	cmd := exec.Command("msiexec.exe",
		"/i", msiPath,
		"SERVERURL="+server,
		"APIKEY="+apiKey,
		"/qb",
	)

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		appendLog("ERROR launching msiexec: " + err.Error())
		_ = os.Remove(msiPath)
		return
	}
	go streamLog(stdout)
	go streamLog(stderr)

	if err := cmd.Wait(); err != nil {
		appendLog("msiexec exited with error: " + err.Error())
	} else {
		appendLog("msiexec completed successfully.")
	}
	_ = os.Remove(msiPath)
	appendLog("Done. The agent should now appear in the Obliview admin panel once approved.")
}

func streamLog(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			appendLog(string(bytes.TrimRight(buf[:n], "\r\n")))
		}
		if err != nil {
			return
		}
	}
}

func main() {
	cfg := readEmbeddedConfig()

	if err := (MainWindow{
		AssignTo: &mw,
		Title:    "Obliview Install Wizard (" + version + ")",
		MinSize:  Size{Width: 520, Height: 460},
		Size:     Size{Width: 580, Height: 500},
		Layout:   VBox{},
		Children: []Widget{
			Label{Text: "Install the Obliview monitoring agent on this host.", Font: Font{PointSize: 10}},
			VSpacer{Size: 6},
			Composite{
				Layout: Grid{Columns: 2, Spacing: 6},
				Children: []Widget{
					Label{Text: "Server URL:"},
					LineEdit{AssignTo: &serverEdit, Text: cfg.ServerURL},
					Label{Text: "API Key:"},
					LineEdit{AssignTo: &apiKeyEdit, Text: cfg.APIKey},
				},
			},
			VSpacer{Size: 6},
			PushButton{
				AssignTo: &installBtn,
				Text:     "Install",
				OnClicked: func() {
					go runInstall()
				},
			},
			VSpacer{Size: 6},
			Label{Text: "Log:"},
			TextEdit{
				AssignTo: &logEdit,
				ReadOnly: true,
				VScroll:  true,
				MinSize:  Size{Height: 200},
				Font:     Font{Family: "Consolas", PointSize: 9},
			},
		},
	}).Create(); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to create window:", err)
		os.Exit(1)
	}
	mw.Run()
}
