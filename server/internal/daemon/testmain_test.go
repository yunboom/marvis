// Copyright 2026 Marvis. All rights reserved.

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// TestMain redirects the home environment variables to one scratch directory
// for the whole binary before any test runs. Config paths resolve through
// os.UserHomeDir — USERPROFILE on Windows, HOME elsewhere — while Hermes uses
// LOCALAPPDATA on Windows. Process-wide redirection isolates tests that forget
// their own redirect; per-test t.Setenv overrides still take precedence.
func TestMain(m *testing.M) {
	for _, key := range []string{
		"MARVIS_AGENT_ID",
		"MARVIS_TASK_ID",
		"MARVIS_TOKEN",
		"MARVIS_DAEMON_PORT",
		"MARVIS_WORKSPACE_ID",
		"MARVIS_SERVER_URL",
		"MARVIS_TASK_CONFIG_ROOT",
	} {
		os.Unsetenv(key)
	}

	scratchHome, err := testutil.IsolateUserHome("marvis-daemon-tests-home-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "isolate internal/daemon test home: %v\n", err)
		os.Exit(1)
	}
	if err := os.Setenv("LOCALAPPDATA", filepath.Join(scratchHome, "AppData", "Local")); err != nil {
		fmt.Fprintf(os.Stderr, "isolate internal/daemon LOCALAPPDATA: %v\n", err)
		_ = os.RemoveAll(scratchHome)
		os.Exit(1)
	}

	code := m.Run()
	_ = os.RemoveAll(scratchHome)
	os.Exit(code)
}

var redirectTestHome = testutil.RedirectUserHome
