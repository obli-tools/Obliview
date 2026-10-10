//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// sendNativeNotification fires a Windows 10+ Toast notification via PowerShell.
func sendNativeNotification(title, body, appName string) {
	// Escape single quotes for PowerShell string literals.
	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	xml := fmt.Sprintf(`<toast><visual><binding template='ToastGeneric'><text>%s</text><text>%s</text></binding></visual></toast>`,
		esc(title), esc(body))

	ps := fmt.Sprintf(
		`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;`+
			`[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null;`+
			`$x=[Windows.Data.Xml.Dom.XmlDocument]::new();`+
			`$x.LoadXml('%s');`+
			`$t=[Windows.UI.Notifications.ToastNotification]::new($x);`+
			`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ObliTools').Show($t)`,
		esc(xml))

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("[oblitools] native notification error: %v — %s\n", err, string(out))
	}
}
