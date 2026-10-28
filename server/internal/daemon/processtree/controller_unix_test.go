//go:build !windows

package processtree

import (
	"errors"
	"syscall"
	"testing"
	"time"
)

// fakeGroup answers group signals the way the kernel would for a group whose
// SIGKILL is refused and which disappears after gone probes (or never, if gone
// is negative).
type fakeGroup struct {
	killErr error
	gone    int
	probes  int
}

func (f *fakeGroup) signal(_ int, sig syscall.Signal) error {
	if sig == syscall.SIGKILL {
		return f.killErr
	}

	f.probes++
	if f.gone >= 0 && f.probes > f.gone {
		return syscall.ESRCH
	}

	return syscall.EPERM
}

func TestFinishGroupGroupKillDenied(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		mayDeny   bool
		killErr   error
		gone      int
		wantErrIs error
		wantStuck bool
	}{
		{name: "exiting group on darwin is waited out", mayDeny: true, killErr: syscall.EPERM, gone: 3},
		{name: "member that never leaves still fails after the wait", mayDeny: true, killErr: syscall.EPERM, gone: -1, wantStuck: true},
		{name: "EPERM elsewhere is returned at once", mayDeny: false, killErr: syscall.EPERM, gone: 3, wantErrIs: syscall.EPERM},
		{name: "other kill errors are returned at once", mayDeny: true, killErr: syscall.EINVAL, gone: 3, wantErrIs: syscall.EINVAL},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			group := &fakeGroup{killErr: tc.killErr, gone: tc.gone}
			c := &controller{signal: group.signal, groupKillMayDenyExiting: tc.mayDeny, finishTimeout: 100 * time.Millisecond}

			err := c.finishGroup(4242)

			switch {
			case tc.wantErrIs != nil:
				if !errors.Is(err, tc.wantErrIs) {
					t.Fatalf("finishGroup error = %v, want %v", err, tc.wantErrIs)
				}
			case tc.wantStuck:
				if err == nil {
					t.Fatal("finishGroup error = nil, want the group reported as still active")
				}
			default:
				if err != nil {
					t.Fatalf("finishGroup error = %v, want nil", err)
				}
			}
		})
	}
}
