//go:build !windows

package evaluation

func pathIsReparsePoint(string) (bool, error) { return false, nil }
