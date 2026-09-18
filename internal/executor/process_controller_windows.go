//go:build windows

package executor

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

const (
	createSuspended                        = 0x00000004
	processTerminate                       = 0x0001
	processSetQuota                        = 0x0100
	processSynchronizeAccess               = 0x00100000
	threadSuspendResume                    = 0x0002
	jobObjectExtendedLimitInformationClass = 9
	jobObjectLimitKillOnJobClose           = 0x00002000
	terminateJobExitCode                   = 1
)

var (
	kernel32DLL                  = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32DLL.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32DLL.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32DLL.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32DLL.NewProc("TerminateJobObject")
	procThread32First            = kernel32DLL.NewProc("Thread32First")
	procThread32Next             = kernel32DLL.NewProc("Thread32Next")
	procOpenThread               = kernel32DLL.NewProc("OpenThread")
	procResumeThread             = kernel32DLL.NewProc("ResumeThread")
)

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type threadEntry32 struct {
	Size           uint32
	Usage          uint32
	ThreadID       uint32
	OwnerProcessID uint32
	BasePri        int32
	DeltaPri       int32
	Flags          uint32
}

type windowsProcessController struct {
	mu         sync.Mutex
	job        syscall.Handle
	process    syscall.Handle
	assigned   bool
	terminated bool
	closed     bool
}

func newProcessController() (processController, error) {
	handle, _, callErr := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return nil, win32CallError("CreateJobObjectW", callErr)
	}

	controller := &windowsProcessController{job: syscall.Handle(handle)}
	info := jobObjectExtendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, callErr := procSetInformationJobObject.Call(
		handle,
		uintptr(jobObjectExtendedLimitInformationClass),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ok == 0 {
		_ = syscall.CloseHandle(controller.job)
		controller.job = 0
		controller.closed = true
		return nil, win32CallError("SetInformationJobObject", callErr)
	}
	return controller, nil
}

func (c *windowsProcessController) configure(cmd *exec.Cmd) error {
	if cmd == nil {
		return fmt.Errorf("command is required")
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= createSuspended
	return nil
}

func (c *windowsProcessController) afterStart(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return fmt.Errorf("started process is required")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.job == 0 {
		return fmt.Errorf("process lifecycle boundary is closed")
	}

	processHandle, err := syscall.OpenProcess(processSetQuota|processTerminate|processSynchronizeAccess, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fmt.Errorf("open started process for job assignment: %w", err)
	}

	ok, _, callErr := procAssignProcessToJobObject.Call(uintptr(c.job), uintptr(processHandle))
	if ok == 0 {
		_ = syscall.CloseHandle(processHandle)
		return win32CallError("AssignProcessToJobObject", callErr)
	}
	c.process = processHandle
	c.assigned = true

	if err := resumeSuspendedProcess(uint32(cmd.Process.Pid)); err != nil {
		return err
	}
	return nil
}

func (c *windowsProcessController) cancel(cmd *exec.Cmd) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return os.ErrProcessDone
	}
	if c.terminated {
		return nil
	}
	if c.assigned && c.job != 0 {
		if c.process != 0 {
			status, waitErr := syscall.WaitForSingleObject(c.process, 0)
			if waitErr != nil {
				return fmt.Errorf("inspect root process state: %w", waitErr)
			}
			if status == syscall.WAIT_OBJECT_0 {
				return os.ErrProcessDone
			}
			if status != syscall.WAIT_TIMEOUT {
				return fmt.Errorf("inspect root process state: unexpected wait status %d", status)
			}
		}
		ok, _, callErr := procTerminateJobObject.Call(uintptr(c.job), terminateJobExitCode)
		if ok == 0 {
			return win32CallError("TerminateJobObject", callErr)
		}
		c.terminated = true
		return nil
	}
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	err := cmd.Process.Kill()
	if err == nil || err == os.ErrProcessDone {
		c.terminated = true
	}
	return err
}

func (c *windowsProcessController) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	jobHandle := c.job
	processHandle := c.process
	c.job = 0
	c.process = 0
	var first error
	if jobHandle != 0 {
		if err := syscall.CloseHandle(jobHandle); err != nil {
			first = fmt.Errorf("close process job: %w", err)
		}
	}
	if processHandle != 0 {
		if err := syscall.CloseHandle(processHandle); err != nil && first == nil {
			first = fmt.Errorf("close root process handle: %w", err)
		}
	}
	return first
}

func resumeSuspendedProcess(pid uint32) error {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("snapshot started process threads: %w", err)
	}
	defer syscall.CloseHandle(snapshot)

	entry := threadEntry32{Size: uint32(unsafe.Sizeof(threadEntry32{}))}
	ok, _, callErr := procThread32First.Call(
		uintptr(snapshot),
		uintptr(unsafe.Pointer(&entry)),
	)
	if ok == 0 {
		return win32CallError("Thread32First", callErr)
	}

	for {
		if entry.OwnerProcessID == pid {
			thread, _, callErr := procOpenThread.Call(threadSuspendResume, 0, uintptr(entry.ThreadID))
			if thread == 0 {
				return win32CallError("OpenThread", callErr)
			}
			resumeCount, _, resumeErr := procResumeThread.Call(thread)
			closeErr := syscall.CloseHandle(syscall.Handle(thread))
			if resumeCount == ^uintptr(0) {
				return win32CallError("ResumeThread", resumeErr)
			}
			if closeErr != nil {
				return fmt.Errorf("close process thread: %w", closeErr)
			}
			if resumeCount != 1 {
				return fmt.Errorf("resume started process: unexpected suspend count %d", resumeCount)
			}
			return nil
		}

		ok, _, callErr = procThread32Next.Call(
			uintptr(snapshot),
			uintptr(unsafe.Pointer(&entry)),
		)
		if ok == 0 {
			break
		}
	}
	return fmt.Errorf("resume started process: main thread not found")
}

func win32CallError(operation string, err error) error {
	if errno, ok := err.(syscall.Errno); ok && errno == 0 {
		return fmt.Errorf("%s failed", operation)
	}
	if err == nil {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
