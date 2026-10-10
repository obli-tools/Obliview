//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// updateDirSDDL is the security descriptor of %ProgramData%\ObliviewAgent\update:
// a protected DACL (P — nothing inherited from C:\ProgramData, whose default
// ACL lets BUILTIN\Users create files and folders) granting full control to
// LocalSystem (SY) and BUILTIN\Administrators (BA) only, inherited by the
// files created inside (OICI). Standard users can neither read the staged MSI
// and the installer log nor swap the MSI between verification and msiexec.
const updateDirSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// updateStaging returns the directory the update MSI is downloaded into and
// the os.CreateTemp pattern for its file name.
//
// The directory is recreated on every attempt: whatever is at the path is
// removed first (a stale MSI from an earlier attempt, or a folder or junction
// a local user planted there), then CreateDirectory creates it with
// updateDirSDDL. CreateDirectory fails if anything re-appeared at the path in
// between, so the directory written into is always the one created here with
// the restricted ACL.
func updateStaging() (dir, pattern string, err error) {
	dir = filepath.Join(configDir, "update")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return "", "", err
	}
	if err := os.RemoveAll(dir); err != nil {
		return "", "", fmt.Errorf("cannot remove stale %s: %w", dir, err)
	}
	sd, err := windows.SecurityDescriptorFromString(updateDirSDDL)
	if err != nil {
		return "", "", fmt.Errorf("build security descriptor: %w", err)
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", "", err
	}
	if err := windows.CreateDirectory(p, &sa); err != nil {
		return "", "", fmt.Errorf("cannot create %s: %w", dir, err)
	}
	return dir, "obliview-agent-update-*.msi", nil
}

// installUpdate runs msiexec directly on the verified MSI — no batch script,
// no os.Exit. msiexec hands the work to the Windows Installer service
// (msiserver), which:
//
//  1. stops the ObliviewAgent service through the SCM (WiX ServiceControl
//     Stop="both") — our svc handler returns and this process exits cleanly;
//  2. replaces obliview-agent.exe and the other packaged files;
//  3. starts the ObliviewAgent service again with the new binary.
//
// The caller simply returns to its loop: the SCM stops us within seconds.
//
// SERVERURL / APIKEY are still passed so the MSI keeps the service arguments
// and the registry fallback populated, exactly as before. They now only live
// in msiexec's argument list (and in its verbose log, which sits in the
// SYSTEM/Administrators-only update directory) — never in a script on disk.
func installUpdate(cfg *Config, msiPath, version string) error {
	sysDir, err := windows.GetSystemDirectory()
	if err != nil || sysDir == "" {
		sysDir = filepath.Join(os.Getenv("SystemRoot"), "System32")
	}
	msiexec := filepath.Join(sysDir, "msiexec.exe")
	logPath := filepath.Join(filepath.Dir(msiPath), "obliview-update.log")

	cmd, err := startInstaller(msiexec,
		"/i", msiPath,
		"/qn", "/norestart",
		"SERVERURL="+cfg.ServerURL,
		"APIKEY="+cfg.APIKey,
		"/l*v", logPath,
	)
	if err != nil {
		return fmt.Errorf("msiexec start: %w", err)
	}
	log.Printf("Auto-update: msiexec started (PID %d) for v%s — Windows Installer will stop and restart the service (log: %s)",
		cmd.Process.Pid, version, logPath)

	// Normally this process is stopped by the SCM before msiexec returns. If
	// msiexec exits while we are still running, the install did not take over
	// (e.g. 1618 another install in progress, 1603 fatal error): log it and
	// drop the MSI. The caller's retry delay decides when to try again.
	go func() {
		err := cmd.Wait()
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		log.Printf("Auto-update: msiexec exited (code %d, err %v) without replacing this agent — see %s", code, err, logPath)
		os.Remove(msiPath)
	}()
	return nil
}

// startInstaller starts the installer in its own process group and, when
// possible, outside the service's job object so it cannot be torn down with
// the service process. If the job forbids breakaway, CreateProcess fails with
// access denied and the installer is started as a plain child instead.
func startInstaller(name string, args ...string) (*exec.Cmd, error) {
	newCmd := func(flags uint32) *exec.Cmd {
		cmd := exec.Command(name, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		return cmd
	}
	cmd := newCmd(windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_BREAKAWAY_FROM_JOB)
	err := cmd.Start()
	if err == nil {
		return cmd, nil
	}
	log.Printf("Auto-update: msiexec start with job breakaway failed (%v) — retrying as a plain child", err)
	cmd = newCmd(windows.CREATE_NEW_PROCESS_GROUP)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
