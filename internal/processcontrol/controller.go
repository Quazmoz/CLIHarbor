package processcontrol

import "os/exec"

// Controller owns the lifecycle boundary for one directly launched process.
// Windows implementations also own descendants through a Job Object.
type Controller interface {
	Configure(*exec.Cmd) error
	AfterStart(*exec.Cmd) error
	Cancel(*exec.Cmd) error
	Close() error
}

// New creates a platform process-lifecycle controller.
func New() (Controller, error) {
	return newController()
}
