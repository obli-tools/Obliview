// go120.mod — module file for the "nt6" Windows build line (Windows 7 SP1 /
// 8.1 / Server 2008 R2 / 2012 / 2012 R2), compiled with Go 1.20.14
// (C:\Go1.20\bin\go.exe) through -modfile=go120.mod. Same module, same
// sources and same dependency versions as go.mod (which stays at go 1.22 for
// the modern build); only the `go` directive differs. A binary built with
// Go >= 1.21 dies before main() on Windows 7 / 2008 R2 and Go 1.21+ dropped
// Windows < 10 altogether, hence this second module file.
//
// When a dependency moves in go.mod, copy the require blocks here and go.sum
// to go120.sum, and never take a version whose own go.mod needs Go > 1.20.
// Check: GOOS=windows GOARCH=amd64
//   C:\Go1.20\bin\go.exe build -modfile=go120.mod -o <scratch>\x.exe .
//
// The nt6 binary MUST be built with -ldflags "-X main.buildFlavor=nt6"
// (build_flavor.go): the release pipeline passes it.

module github.com/obliview/agent

go 1.20

require (
	github.com/lxn/walk v0.0.0-20210112085537-c389da54e794
	github.com/shirou/gopsutil/v3 v3.24.5
	golang.org/x/sys v0.20.0
)

require (
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/lxn/win v0.0.0-20210218163916-a377121e959e // indirect
	github.com/power-devops/perfstat v0.0.0-20210106213030-5aafc221ea8c // indirect
	github.com/shoenig/go-m1cpu v0.1.6 // indirect
	github.com/tklauser/go-sysconf v0.3.12 // indirect
	github.com/tklauser/numcpus v0.6.1 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	gopkg.in/Knetic/govaluate.v3 v3.0.0 // indirect
)
