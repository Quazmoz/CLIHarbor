package processenv

import (
	"os"
	"runtime"
)

// Minimal returns the small inherited environment needed for direct local
// utility execution without forwarding arbitrary parent-process secrets.
// Executable resolution is absolute, so PATH is intentionally excluded.
func Minimal() []string {
	names := []string{"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"}
	if runtime.GOOS == "windows" {
		names = []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}
	}
	env := make([]string, 0, len(names))
	for _, name := range names {
		if value, ok := os.LookupEnv(name); ok && value != "" {
			env = append(env, name+"="+value)
		}
	}
	return env
}

// NeutralHome returns the minimal inherited environment plus a caller-owned
// synthetic home directory. Probe subprocesses need a valid user home because
// some official CLIs resolve home-scoped defaults while constructing commands,
// even for --version/--help. Pointing those lookups at the probe's temporary
// directory preserves that startup contract without exposing the real user's
// home-scoped configuration or arbitrary parent-process environment.
func NeutralHome(home string) []string {
	env := Minimal()
	if home == "" {
		return env
	}
	env = append(env, "HOME="+home)
	if runtime.GOOS == "windows" {
		env = append(env, "USERPROFILE="+home)
	}
	return env
}
