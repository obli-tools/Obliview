//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// uninstallExits reports whether handleUninstallCommand must exit the process
// once the uninstaller is launched. On Windows msiexec stops the service
// through the SCM (WiX ServiceControl), exactly like an update, so the agent
// keeps running until then.
const uninstallExits = false

// startDetachedShell is only used by the Linux / macOS uninstall paths, which
// are unreachable on Windows (runtime.GOOS switch).
func startDetachedShell(_ string) error {
	return fmt.Errorf("shell uninstall is not available on windows")
}

// handleWindowsUninstall downloads and verifies the MSI into the SYSTEM /
// Administrators-only staging directory (same path as an auto-update), then
// runs msiexec /x on it directly — no batch script and nothing in a shared
// temp directory a local user could tamper with. The MSI uninstall stops the
// service, removes all files and the PawnIO kernel driver (via WiX
// ServiceControl + CA.UninstallPawnIO).
func handleWindowsUninstall(cfg *Config) error {
	// Never race an auto-update for the staging directory.
	updateMu.Lock()
	if updateInProgress {
		updateMu.Unlock()
		return fmt.Errorf("an update is in progress, retry later")
	}
	updateInProgress = true
	updateMu.Unlock()
	release := func() {
		updateMu.Lock()
		updateInProgress = false
		updateMu.Unlock()
	}

	msiPath, err := downloadUpdate(cfg)
	if err != nil {
		release()
		return fmt.Errorf("download MSI: %w", err)
	}

	sysDir, err := windows.GetSystemDirectory()
	if err != nil || sysDir == "" {
		sysDir = filepath.Join(os.Getenv("SystemRoot"), "System32")
	}
	logPath := filepath.Join(filepath.Dir(msiPath), "obliview-uninstall.log")

	cmd, err := startInstaller(filepath.Join(sysDir, "msiexec.exe"),
		"/x", msiPath,
		"/qn", "/norestart",
		"/l*v", logPath,
	)
	if err != nil {
		os.Remove(msiPath)
		release()
		return fmt.Errorf("msiexec start: %w", err)
	}
	log.Printf("Uninstall: msiexec started (PID %d) — Windows Installer will stop and remove the service (log: %s)",
		cmd.Process.Pid, logPath)

	// Normally the SCM stops this process before msiexec returns. If msiexec
	// exits while we are still running, the uninstall did not take over.
	go func() {
		err := cmd.Wait()
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		log.Printf("Uninstall: msiexec exited (code %d, err %v) without removing this agent — see %s", code, err, logPath)
		os.Remove(msiPath)
		release()
	}()
	return nil
}
