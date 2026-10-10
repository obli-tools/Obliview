package main

import (
	"runtime"
	"testing"
)

func TestAgentMSIName(t *testing.T) {
	cases := []struct {
		arch string
		nt6  bool
		want string
	}{
		{"amd64", false, "obliview-agent.msi"}, // modern name unchanged
		{"amd64", true, "obliview-agent-nt6.msi"},
		{"arm64", false, "obliview-agent.msi"},
		{"386", false, "obliview-agent-x86.msi"},
		{"386", true, "obliview-agent-nt6-x86.msi"},
	}
	for _, c := range cases {
		if got := agentMSIName(c.arch, c.nt6); got != c.want {
			t.Errorf("%s nt6=%v: %q want %q", c.arch, c.nt6, got, c.want)
		}
	}
}

func TestBuildFlavor(t *testing.T) {
	saved := buildFlavor
	defer func() { buildFlavor = saved }()

	buildFlavor = ""
	if isNT6Build() || agentBuildName() != "modern" {
		t.Fatalf("default build must be modern")
	}
	buildFlavor = buildFlavorNT6
	if !isNT6Build() || agentBuildName() != "nt6" {
		t.Fatalf("nt6 build not detected")
	}
	// An nt6 binary never leaves the nt6 line, whatever the OS.
	if got, want := currentAgentMSIName(), agentMSIName(runtime.GOARCH, true); got != want {
		t.Fatalf("nt6 build: %q want %q", got, want)
	}

	// A modern binary stays modern unless the OS is Windows NT 6.x.
	buildFlavor = ""
	if got, want := currentAgentMSIName(), agentMSIName(runtime.GOARCH, osNeedsNT6Build()); got != want {
		t.Fatalf("modern build: %q want %q", got, want)
	}
	if runtime.GOOS != "windows" && osNeedsNT6Build() {
		t.Fatalf("osNeedsNT6Build must be false off Windows")
	}
}
