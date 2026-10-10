package main

import (
	"log"
	"os"
	"runtime"
)

// handleUninstallCommand is called when the server delivers an 'uninstall' command
// in a push response.
//
// Windows: msiexec /x runs directly on the verified MSI staged in the
// SYSTEM/Administrators-only update directory; the SCM then stops this
// service, so the agent does not exit by itself.
// Linux / macOS: a detached shell (own session, script passed inline — never
// written to /tmp) removes the service once the agent has exited.
func handleUninstallCommand(cfg *Config) {
	log.Printf("Uninstall command received — initiating self-removal...")

	var err error
	switch runtime.GOOS {
	case "windows":
		err = handleWindowsUninstall(cfg)
	case "linux":
		err = handleLinuxUninstall()
	case "darwin":
		err = handleDarwinUninstall()
	default:
		log.Printf("Uninstall: unsupported platform %q — ignoring command", runtime.GOOS)
		return
	}

	if err != nil {
		log.Printf("Uninstall: failed to launch uninstaller: %v", err)
		return
	}

	if !uninstallExits {
		log.Printf("Uninstall: uninstaller launched — waiting for it to stop the service")
		return
	}
	log.Printf("Uninstall: script launched, shutting down agent...")
	os.Exit(0)
}

// ── Linux ─────────────────────────────────────────────────────────────────────

// handleLinuxUninstall stops and removes the obliview-agent systemd (or
// init.d) service and its binary from a detached shell, so it survives the
// agent process exit.
func handleLinuxUninstall() error {
	script := "sleep 2\n" +
		// Stop and disable — works for both systemd and SysV init
		"systemctl stop obliview-agent 2>/dev/null || service obliview-agent stop 2>/dev/null || true\n" +
		"systemctl disable obliview-agent 2>/dev/null || true\n" +
		// Remove service unit / init script
		"rm -f /etc/systemd/system/obliview-agent.service /etc/init.d/obliview-agent\n" +
		"systemctl daemon-reload 2>/dev/null || true\n" +
		// Remove binary and install directory (config at /etc/obliview-agent/ is kept)
		"rm -rf /opt/obliview-agent/\n"

	return startDetachedShell(script)
}

// ── macOS ─────────────────────────────────────────────────────────────────────

// handleDarwinUninstall unloads the launchd daemon and removes the plist and
// the installed binary from a detached shell.
// Config and logs at /etc/obliview-agent/ and /var/log/obliview-agent.log are
// preserved (same behaviour as `obliview-agent uninstall`).
func handleDarwinUninstall() error {
	const plist = "/Library/LaunchDaemons/com.obliview.agent.plist"
	const binary = "/usr/local/bin/obliview-agent"

	script := "sleep 2\n" +
		// Unload the launchd daemon (prevents auto-restart)
		"launchctl unload " + plist + " 2>/dev/null || true\n" +
		"rm -f " + plist + "\n" +
		"rm -f " + binary + "\n"

	return startDetachedShell(script)
}
