//go:build windows

package main

import (
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// windowsOSVersion is the real OS version (RtlGetVersion ignores the
// compatibility manifest, unlike GetVersionEx): 10 = Windows 10 / 11 /
// Server 2016+, 6.1 = Windows 7 / 2008 R2, 6.2 = 8 / 2012, 6.3 = 8.1 /
// 2012 R2. Zeros when unavailable.
func windowsOSVersion() (major, minor, build uint32) {
	if v := windows.RtlGetVersion(); v != nil {
		return v.MajorVersion, v.MinorVersion, v.BuildNumber
	}
	return 0, 0, 0
}

// ── Windows NT 6.x capability probes (nt6 build line) ────────────────────────
//
// The Windows-specific collectors shell out to PowerShell. Windows 7 /
// 2008 R2 ship PowerShell 2.0 (CLR 2), Server 2012 3.0, 8.1 / 2012 R2 4.0,
// unless WMF 5.1 was installed. The probes below are plain registry reads (no
// PowerShell start) and are computed once: they only change with an update
// followed by a reboot, which restarts the agent anyway.

var (
	nt6CapsOnce   sync.Once
	nt6PSMajor    int    // Windows PowerShell engine major version (0 = unknown)
	nt6DotNet4Rel uint64 // .NET Framework 4.x "Release" value (0 = not installed)
)

func probeNT6Caps() {
	nt6CapsOnce.Do(func() {
		nt6PSMajor = readPowerShellEngineMajor()
		nt6DotNet4Rel = readDotNet4Release()
	})
}

// readPowerShellEngineMajor reads the Windows PowerShell engine version from
// the registry: ...\PowerShell\3\PowerShellEngine for 3.0 - 5.1, ...\1\ for
// 2.0 (and 1.0).
func readPowerShellEngineMajor() int {
	for _, key := range []string{
		`SOFTWARE\Microsoft\PowerShell\3\PowerShellEngine`,
		`SOFTWARE\Microsoft\PowerShell\1\PowerShellEngine`,
	} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, key, registry.QUERY_VALUE|registry.WOW64_64KEY)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("PowerShellVersion")
		k.Close()
		if err != nil {
			continue
		}
		head := strings.SplitN(strings.TrimSpace(v), ".", 2)[0]
		if n, err := strconv.Atoi(head); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// readDotNet4Release returns the .NET Framework 4.x "Release" value
// (461808+ = 4.7.2), 0 when .NET 4.5+ is not installed.
func readDotNet4Release() uint64 {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return 0
	}
	defer k.Close()
	rel, _, err := k.GetIntegerValue("Release")
	if err != nil {
		return 0
	}
	return rel
}

// dotNet472Release is the lowest .NET Framework 4.7.2 "Release" value.
const dotNet472Release = 461808

// lhmDLLUsable reports whether the bundled LibreHardwareMonitor DLLs (net472
// build, loaded by a PowerShell .NET-reflection script) can work on this
// host. Always true on Windows 10+ (behaviour unchanged). On Windows NT 6.x
// they need PowerShell 3+ (PowerShell 2.0 runs on CLR 2 and cannot load a
// .NET 4 assembly) and .NET Framework 4.7.2+. Otherwise the DLL extraction
// and the PowerShell run are skipped: temperatures then only come from a
// separately installed LHM service (WMI) or ASUS ATK, or are unavailable.
func lhmDLLUsable() bool {
	if !osNeedsNT6Build() {
		return true
	}
	probeNT6Caps()
	return nt6PSMajor >= 3 && nt6DotNet4Rel >= dotNet472Release
}

// storageCmdletsUsable reports whether the Storage PowerShell module
// (Get-PhysicalDisk, Get-StorageReliabilityCounter) can exist here: Windows 8
// / Server 2012 (NT 6.2) and later, PowerShell 3+. Always true on Windows 10+.
// Windows 7 / 2008 R2 skip a PowerShell run that can only fail.
func storageCmdletsUsable() bool {
	if !osNeedsNT6Build() {
		return true
	}
	_, minor, _ := windowsOSVersion()
	probeNT6Caps()
	return minor >= 2 && nt6PSMajor >= 3
}
