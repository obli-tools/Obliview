//go:build darwin

package main

import (
	"fmt"
	"os/exec"
)

// sendNativeNotification fires a macOS Notification Center notification via osascript.
func sendNativeNotification(title, body, appName string) {
	script := fmt.Sprintf(`display notification %q with title %q`, body, title)
	cmd := exec.Command("osascript", "-e", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("[oblitools] native notification error: %v — %s\n", err, string(out))
	}
}
