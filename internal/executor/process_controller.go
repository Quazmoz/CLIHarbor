package executor

import (
	"os/exec"

	"github.com/Quazmoz/CLIHarbor/internal/processcontrol"
)

type processController interface {
	configure(*exec.Cmd) error
	afterStart(*exec.Cmd) error
	cancel(*exec.Cmd) error
	close() error
}

type processControllerFactory func() (processController, error)

type sharedProcessController struct {
	inner processcontrol.Controller
}

func newProcessController() (processController, error) {
	controller, err := processcontrol.New()
	if err != nil {
		return nil, err
	}
	return sharedProcessController{inner: controller}, nil
}

func (c sharedProcessController) configure(cmd *exec.Cmd) error {
	return c.inner.Configure(cmd)
}

func (c sharedProcessController) afterStart(cmd *exec.Cmd) error {
	return c.inner.AfterStart(cmd)
}

func (c sharedProcessController) cancel(cmd *exec.Cmd) error {
	return c.inner.Cancel(cmd)
}

func (c sharedProcessController) close() error {
	return c.inner.Close()
}
