package main

import "runtime"

// buildFlavor selects the Windows build line of this binary. It is injected at
// build time and is "" (= modern) unless the build script says otherwise:
//
//	go build -ldflags "-X main.agentVersion=x.y.z -X main.buildFlavor=nt6" ...
//
// "nt6" = the agent built with Go 1.20 (go120.mod) for Windows 7 SP1 / 8.1 /
// Server 2008 R2 / 2012 / 2012 R2. Same source code as the modern agent; it
// only exists because a binary built with Go >= 1.21 dies before main() on
// Windows 7 / 2008 R2 (runtime -> ProcessPrng in bcryptprimitives.dll, no
// fallback) and Go 1.21+ dropped Windows < 10 support altogether.
//
// Without the -X flag an nt6 binary believes it is modern: on Windows < 10
// osNeedsNT6Build still keeps it on the nt6 MSI, but always pass the flag.
var buildFlavor = ""

const buildFlavorNT6 = "nt6"

// isNT6Build reports whether this binary is the Go 1.20 build for Windows < 10.
func isNT6Build() bool { return buildFlavor == buildFlavorNT6 }

// agentBuildName is the value reported in the heartbeat / push body as
// `agentBuild` ("modern" | "nt6").
func agentBuildName() string {
	if isNT6Build() {
		return buildFlavorNT6
	}
	return "modern"
}

// agentMSIName is the installer this agent downloads (from
// /api/agent/download/) to update or uninstall itself on Windows:
//
//	obliview-agent.msi       modern, x64 (unchanged name)
//	obliview-agent-nt6.msi   nt6, x64
//
// plus a "-x86" suffix for a 32-bit agent (no x86 MSI is built today: the
// server answers 404 and the agent keeps running its current version).
func agentMSIName(goarch string, nt6 bool) string {
	name := "obliview-agent"
	if nt6 {
		name += "-nt6"
	}
	if goarch == "386" {
		name += "-x86"
	}
	return name + ".msi"
}

// currentAgentMSIName is agentMSIName for this binary on this OS. The nt6
// build stays on the nt6 line (a modern MSI would install a binary that cannot
// start on Windows 7 / 2008 R2, which the modern MSI refuses anyway); a modern
// agent running on Windows NT 6.x (8.1 / 2012 / 2012 R2 installs made before
// the nt6 line: the modern MSI still installs there so that those agents can
// update to this code) moves to it at its next update.
func currentAgentMSIName() string {
	return agentMSIName(runtime.GOARCH, isNT6Build() || osNeedsNT6Build())
}
