//go:build !windows && !darwin

package main

// sendNativeNotification is a no-op on unsupported platforms.
func sendNativeNotification(_, _, _ string) {}
