//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

// uninstallExits reports whether handleUninstallCommand must exit the process
// once the uninstall script is launched (Unix: yes, the script cleans up after
// the agent is gone).
const uninstallExits = true

// handleWindowsUninstall is only reachable on Windows (runtime.GOOS switch).
func handleWindowsUninstall(_ *Config) error {
	return errors.New("windows uninstall is not available on this platform")
}

// startDetachedShell runs script with /bin/sh -c in its own session so it
// outlives the agent process. The script is passed inline: nothing is written
// to a predictable path in a world-writable directory such as /tmp.
func startDetachedShell(script string) error {
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}
