//go:build !windows

package processtree

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

const processTreeFinishTimeout = 5 * time.Second

type controller struct {
	// signal sends sig to a process (pid > 0) or process group (pid < 0).
	signal func(pid int, sig syscall.Signal) error
	// groupKillMayDenyExiting reports that signalling a group whose remaining
	// members are all exiting can fail with EPERM. Darwin does this for a
	// group left with only a not-yet-reaped zombie; the group disappears a few
	// milliseconds later.
	groupKillMayDenyExiting bool
	finishTimeout           time.Duration
}

func newController(cmd *exec.Cmd) (*controller, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return &controller{
		signal:                  syscall.Kill,
		groupKillMayDenyExiting: runtime.GOOS == "darwin",
		finishTimeout:           processTreeFinishTimeout,
	}, nil
}

func (*controller) attach(_ *exec.Cmd) error { return nil }

func (*controller) interrupt(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	return nil
}

func (*controller) stop(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return cmd.Process.Kill()
	}
	return nil
}

func (c *controller) finish(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}

	return c.finishGroup(cmd.Process.Pid)
}

// finishGroup kills whatever is left of process group pgid and waits for the
// group to disappear.
func (c *controller) finishGroup(pgid int) error {
	if err := c.signal(-pgid, 0); errors.Is(err, syscall.ESRCH) {
		return nil
	}

	// A normally-exited leader can still leave a descendant holding inherited
	// pipes or repository locks. Kill the remaining group before returning
	// ownership of the repository to another operation.
	if err := c.signal(-pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		// An EPERM here can also be a member we may not signal. Waiting below
		// still surfaces that case: such a member never leaves the group.
		if !c.groupKillMayDenyExiting || !errors.Is(err, syscall.EPERM) {
			return err
		}
	}

	deadline := time.Now().Add(c.finishTimeout)
	for time.Now().Before(deadline) {
		if err := c.signal(-pgid, 0); errors.Is(err, syscall.ESRCH) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}

	return fmt.Errorf("process group %d still active after %s", pgid, c.finishTimeout)
}

func (*controller) close() {}
