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
