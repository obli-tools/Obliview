//go:build windows

package main

// osNeedsNT6Build: Windows 7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2
// (NT 6.x) must run the nt6 build. A modern agent already installed on such
// a system moves to the nt6 line at its next update (the modern MSI only
// refuses Windows 7 / 2008 R2, so that older agents on 8.1 / 2012 / 2012 R2
// can still update to a version that knows the nt6 line). Unknown version
// (0) = not NT 6.x.
func osNeedsNT6Build() bool {
	major, _, _ := windowsOSVersion()
	return major != 0 && major < 10
}
