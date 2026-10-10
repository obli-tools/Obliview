//go:build windows

package main

import "testing"

func TestWindowsOSVersionAndNT6Gates(t *testing.T) {
	major, minor, build := windowsOSVersion()
	if major == 0 {
		t.Fatal("RtlGetVersion returned zeros")
	}
	t.Logf("Windows %d.%d build %d, PowerShell engine %d, .NET 4 release %d",
		major, minor, build, readPowerShellEngineMajor(), readDotNet4Release())
	if major < 10 {
		t.Skipf("host is Windows NT %d.%d: the modern-path assertions do not apply", major, minor)
	}
	// Windows 10+: every Windows-specific path behaves exactly as before.
	if osNeedsNT6Build() || useFallbackRoots() || !lhmDLLUsable() || !storageCmdletsUsable() {
		t.Fatalf("Windows %d (build %d) must keep the modern paths", major, build)
	}
}
