//go:build !windows

package processcontrol

import (
	"os"
	"os/exec"
)

type directController struct{}

func newController() (Controller, error) {
	return directController{}, nil
}

func (directController) Configure(*exec.Cmd) error  { return nil }
func (directController) AfterStart(*exec.Cmd) error { return nil }

func (directController) Cancel(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	return cmd.Process.Kill()
}

func (directController) Close() error { return nil }
