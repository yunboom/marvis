// Copyright 2026 Marvis. All rights reserved.

package cli

import (
	"fmt"
	"os"
	"testing"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// TestMain redirects both home environment variables to one scratch directory
// for the whole binary before any test runs. This package owns SaveCLIConfig,
// which resolves ~/.marvis-studio through os.UserHomeDir — USERPROFILE on Windows,
// HOME elsewhere. Tests that only redirect HOME therefore split the fixture's
// write path from the code's read path on Windows: SaveCLIConfig writes test
// fixtures over a real default-profile config.json. Process-wide redirection
// isolates tests that forget their own redirect on every platform; per-test
// t.Setenv overrides still take precedence.
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

	scratchHome, err := testutil.IsolateUserHome("marvis-cli-config-tests-home-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "isolate internal/cli test home: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()
	_ = os.RemoveAll(scratchHome)
	os.Exit(code)
}

var redirectTestHome = testutil.RedirectUserHome
