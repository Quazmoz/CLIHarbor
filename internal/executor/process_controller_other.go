//go:build !windows

package executor

import (
	"os"
	"os/exec"
)

type directProcessController struct{}

func newProcessController() (processController, error) {
	return directProcessController{}, nil
}

func (directProcessController) configure(*exec.Cmd) error {
	return nil
}

func (directProcessController) afterStart(*exec.Cmd) error {
	return nil
}

func (directProcessController) cancel(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	return cmd.Process.Kill()
}

func (directProcessController) close() error {
	return nil
}
