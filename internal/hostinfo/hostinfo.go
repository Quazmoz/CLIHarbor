package hostinfo

import "runtime"

type Info struct {
	OS           string
	Version      string
	Architecture string
}

func Current() Info {
	return Info{
		OS:           runtime.GOOS,
		Version:      platformVersion(),
		Architecture: runtime.GOARCH,
	}
}
