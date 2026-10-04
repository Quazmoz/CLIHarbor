//go:build darwin || linux

package processcontrol

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
)

type groupController struct {
	mu         sync.Mutex
	pid        int
	closed     bool
	terminated bool
}

func newController() (Controller, error) { return &groupController{}, nil }

func (c *groupController) Configure(cmd *exec.Cmd) error {
	if cmd == nil {
		return fmt.Errorf("command is required")
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Establish the group in the child before exec, so even immediate descendants
	// inherit it. Never signal CLIHarbor's own foreground process group.
	cmd.SysProcAttr.Setpgid = true
	cmd.SysProcAttr.Pgid = 0
	return nil
}

func (c *groupController) AfterStart(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return fmt.Errorf("started process is required")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return fmt.Errorf("process lifecycle boundary is closed")
	}
	c.pid = cmd.Process.Pid
	return nil
}

func (c *groupController) Cancel(cmd *exec.Cmd) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	if c.terminated {
		return nil
	}
	// A completed root must retain its exit result even if a surviving child
	// still holds output open. Close owns those remaining descendants.
	if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
		return err
	}
	// CommandContext can cancel between Start and AfterStart. The group already
	// exists by then; use the started process directly instead of c.pid.
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	if err == nil {
		c.terminated = true
	}
	return err
}

func (c *groupController) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	if c.pid == 0 || c.terminated {
		return nil
	}
	// Also clean up descendants when the root exits normally.
	// ponytail: process groups cover descendants that stay in the group;
	// deliberate setsid escapes require a stronger OS sandbox.
	err := syscall.Kill(-c.pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
