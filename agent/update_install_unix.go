//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// updateTempPrefix names the staging files created next to the executable.
const updateTempPrefix = ".obliview-agent-update-"

// updateStaging returns the directory the new binary is downloaded into and
// the os.CreateTemp pattern for its file name.
//
// Unix: the executable's own directory (root-owned: /opt/obliview-agent,
// /usr/local/bin…). Staging on the same filesystem is what makes the final
// os.Rename over the running binary atomic. os.CreateTemp creates the file
// with mode 0600 and an unpredictable name; it only becomes executable
// (0755) once verified, in installUpdate.
func updateStaging() (dir, pattern string, err error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", "", fmt.Errorf("cannot resolve executable path: %w", err)
	}
	dir = filepath.Dir(exePath)
	removeStaleUpdateFiles(dir)
	return dir, updateTempPrefix + "*", nil
}

// removeStaleUpdateFiles deletes staging files left behind by an attempt that
// was interrupted (crash, power loss) before it could clean up.
func removeStaleUpdateFiles(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), updateTempPrefix) && e.Type().IsRegular() {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// installUpdate makes the verified binary executable, renames it over the
// running executable and re-execs into it. It does not return on success.
func installUpdate(_ *Config, binPath, version string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve executable path: %w", err)
	}
	if err := os.Chmod(binPath, 0755); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	if err := os.Rename(binPath, exePath); err != nil {
		return fmt.Errorf("rename over %s: %w", exePath, err)
	}
	log.Printf("Auto-update: updated to v%s, restarting...", version)
	// Exec into the new binary in-place (same PID, works without a service manager).
	restartWithNewBinary(exePath)
	return nil // not reached; restartWithNewBinary always exits
}
