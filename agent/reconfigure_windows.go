//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// agentServiceName is the SCM name of the agent service (product.wxs).
const agentServiceName = "ObliviewAgent"

// persistPlatformCredentials mirrors new credentials into the places the MSI
// wrote them:
//
//   - HKLM\SOFTWARE\ObliviewAgent ServerUrl / ApiKey (fallback read when
//     config.json is missing) — only updated when the key already exists;
//   - the service arguments --url "…" --key "…" (CLI flags override
//     config.json at start-up) — only rewritten when they are present.
//
// Both values were validated by applyReconfigure (no quotes, whitespace or
// control characters), so they cannot break out of the quoted arguments.
func persistPlatformCredentials(serverURL, apiKey string) error {
	var errs []string

	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\ObliviewAgent`, registry.SET_VALUE); err == nil {
		if err := k.SetStringValue("ServerUrl", serverURL); err != nil {
			errs = append(errs, fmt.Sprintf("registry ServerUrl: %v", err))
		}
		if err := k.SetStringValue("ApiKey", apiKey); err != nil {
			errs = append(errs, fmt.Sprintf("registry ApiKey: %v", err))
		}
		k.Close()
	} else if !errors.Is(err, registry.ErrNotExist) {
		errs = append(errs, fmt.Sprintf("registry: %v", err))
	}

	if err := updateServiceArguments(serverURL, apiKey); err != nil {
		errs = append(errs, fmt.Sprintf("service arguments: %v", err))
	}

	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// updateServiceArguments rewrites the service's command line with the new
// --url / --key when it carries them (MSI install). Only the binary path is
// changed (SERVICE_NO_CHANGE for everything else).
func updateServiceArguments(serverURL, apiKey string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(agentServiceName)
	if err != nil {
		// Not installed as a service (interactive run) — nothing to update.
		return nil
	}
	defer s.Close()

	c, err := s.Config()
	if err != nil {
		return fmt.Errorf("query config: %w", err)
	}
	current := c.BinaryPathName
	if !strings.Contains(current, "--key") && !strings.Contains(current, "--url") {
		return nil
	}

	exe := serviceExecutable(current)
	if exe == "" {
		return fmt.Errorf("cannot parse the service command line")
	}
	newPath := fmt.Sprintf(`"%s" --url "%s" --key "%s"`, exe, serverURL, apiKey)
	p, err := windows.UTF16PtrFromString(newPath)
	if err != nil {
		return err
	}
	if err := windows.ChangeServiceConfig(s.Handle,
		windows.SERVICE_NO_CHANGE, windows.SERVICE_NO_CHANGE, windows.SERVICE_NO_CHANGE,
		p, nil, nil, nil, nil, nil, nil); err != nil {
		return fmt.Errorf("change config: %w", err)
	}
	log.Printf("Reconfigure: service arguments updated")
	return nil
}

// serviceExecutable extracts the executable path from a service command line
// (quoted or not); falls back to the running executable.
func serviceExecutable(cmdLine string) string {
	cmdLine = strings.TrimSpace(cmdLine)
	if strings.HasPrefix(cmdLine, `"`) {
		if end := strings.Index(cmdLine[1:], `"`); end > 0 {
			return cmdLine[1 : end+1]
		}
	} else if i := strings.Index(strings.ToLower(cmdLine), ".exe"); i > 0 {
		return cmdLine[:i+4]
	}
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return ""
}

// restartAgentService restarts the ObliviewAgent service from a detached
// process, so the restart survives this process being stopped by the SCM.
// No script is written to disk and no credential is on the command line:
// the new key is already in config.json. PowerShell Restart-Service waits for
// the stop before starting again; when PowerShell is unavailable, cmd.exe runs
// sc stop / sc start with a pause in between.
//
// Returns an error when the agent is not running as a service (interactive
// run) or when no restart process could be started.
func restartAgentService() error {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return errors.New("not running as a Windows service")
	}

	sysDir, err := windows.GetSystemDirectory()
	if err != nil || sysDir == "" {
		sysDir = filepath.Join(os.Getenv("SystemRoot"), "System32")
	}

	powershell := filepath.Join(sysDir, `WindowsPowerShell\v1.0\powershell.exe`)
	if _, statErr := os.Stat(powershell); statErr == nil {
		err = startDetachedProcess(powershell, "",
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-Command", "Start-Sleep -Seconds 1; Restart-Service -Name '"+agentServiceName+"' -Force")
		if err == nil {
			return nil
		}
		log.Printf("Reconfigure: PowerShell restart failed to start (%v) — trying sc.exe", err)
	}

	sc := filepath.Join(sysDir, "sc.exe")
	ping := filepath.Join(sysDir, "PING.EXE")
	script := fmt.Sprintf(`"%s" stop %s >nul & "%s" -n 8 127.0.0.1 >nul & "%s" start %s >nul`,
		sc, agentServiceName, ping, sc, agentServiceName)
	cmdExe := filepath.Join(sysDir, "cmd.exe")
	// cmd.exe does not understand Go's argument escaping: pass the raw command line.
	// /s: strip only the outer quotes of the /c argument, keep the inner ones.
	return startDetachedProcess(cmdExe, `"`+cmdExe+`" /d /s /c "`+script+`"`)
}

// startDetachedProcess starts name outside the service's job object when
// allowed (so it is not torn down with the service), in its own process group
// and without a console. A non-empty rawCmdLine replaces the command line
// built from args (needed for cmd.exe /c).
func startDetachedProcess(name, rawCmdLine string, args ...string) error {
	start := func(flags uint32) error {
		cmd := exec.Command(name, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags, CmdLine: rawCmdLine}
		if err := cmd.Start(); err != nil {
			return err
		}
		go func() { _ = cmd.Wait() }()
		return nil
	}
	base := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS)
	if err := start(base | windows.CREATE_BREAKAWAY_FROM_JOB); err == nil {
		return nil
	}
	return start(base)
}
