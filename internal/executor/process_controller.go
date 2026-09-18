package executor

import "os/exec"

type processController interface {
	configure(*exec.Cmd) error
	afterStart(*exec.Cmd) error
	cancel(*exec.Cmd) error
	close() error
}

type processControllerFactory func() (processController, error)
