//go:build !windows

package hostinfo

func platformVersion() string { return "" }
