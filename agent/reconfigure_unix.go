//go:build !windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

// persistPlatformCredentials: on Linux / macOS / FreeBSD the service
// definitions (systemd unit, launchd plist, rc.d script) carry no credentials
// — config.json is the only copy.
func persistPlatformCredentials(_, _ string) error { return nil }

// restartAgentService restarts the agent through its service manager:
//
//   - Linux under systemd: `systemctl --no-block restart <unit>` (the unit is
//     read from /proc/self/cgroup) — systemd stops this process and starts it
//     again;
//   - macOS: `launchctl kickstart -k system/com.obliview.agent` from a
//     detached session (launchd kills this process and restarts it);
//   - anything else (SysV init, FreeBSD daemon(8), Unraid, manual run): the
//     process re-execs itself in place (same PID), which re-reads config.json.
func restartAgentService() error {
	switch runtime.GOOS {
	case "linux":
		if unit := systemdUnit(); unit != "" {
			cmd := exec.Command("systemctl", "--no-block", "restart", unit)
			out, err := cmd.CombinedOutput()
			if err == nil {
				log.Printf("Reconfigure: systemctl restart %s queued", unit)
				return nil
			}
			log.Printf("Reconfigure: systemctl restart %s failed: %v (%s) — re-executing in place",
				unit, err, strings.TrimSpace(string(out)))
		}
	case "darwin":
		if os.Getppid() == 1 {
			const target = "system/com.obliview.agent"
			err := startDetachedShell("sleep 1\nlaunchctl kickstart -k " + target + "\n")
			if err == nil {
				log.Printf("Reconfigure: launchctl kickstart %s launched", target)
				return nil
			}
			log.Printf("Reconfigure: launchctl kickstart failed to start: %v — re-executing in place", err)
		}
	}
	return reexecSelf()
}

// systemdUnit returns the systemd service unit this process runs in
// ("obliview-agent.service"), or "" when it is not managed by systemd.
func systemdUnit() string {
	if os.Getenv("INVOCATION_ID") == "" {
		return ""
	}
	f, err := os.Open("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		i := strings.LastIndex(line, "/")
		if i < 0 {
			continue
		}
		name := line[i+1:]
		if strings.HasSuffix(name, ".service") && validUnitName(name) {
			return name
		}
	}
	return ""
}

func validUnitName(name string) bool {
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == '-' || r == '_' || r == '.' || r == '@' || r == ':') {
			return false
		}
	}
	return name != ""
}

// reexecSelf replaces the process image with the same binary (same PID, so
// pid-file based supervisors keep tracking it). It does not return on success.
func reexecSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve executable path: %w", err)
	}
	log.Printf("Reconfigure: re-executing %s with the new configuration", exe)
	if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
		return errors.New("re-exec failed: " + err.Error())
	}
	return nil // not reached
}
