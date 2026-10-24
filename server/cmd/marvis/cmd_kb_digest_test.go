package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func newKBDigestTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "digest"}
	cmd.Flags().String("output", "table", "")

	return cmd
}

func digestTestServer(t *testing.T, configured bool, patches *[]map[string]any) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == kbDigestPath:
			resp := map[string]any{"autopilot": nil, "schedule": nil, "knowledge_base_count": 1}
			if configured {
				resp["autopilot"] = map[string]any{"id": "ap-1", "status": "paused", "assignee_id": "agent-1"}
				resp["schedule"] = map[string]any{"id": "tr-1", "cron_expression": "0 22 * * *", "timezone": "UTC"}
			}
			_ = json.NewEncoder(w).Encode(resp)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/autopilots/ap-1":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			*patches = append(*patches, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "ap-1"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("MARVIS_SERVER_URL", srv.URL)
	t.Setenv("MARVIS_WORKSPACE_ID", "ws-1")
	t.Setenv("MARVIS_TOKEN", "test-token")
}

func TestKBDigestEnablePatchesAutopilotStatus(t *testing.T) {
	var patches []map[string]any
	digestTestServer(t, true, &patches)

	out, err := captureStdout(t, func() error { return setKBDigestStatus(newKBDigestTestCmd(), autopilotActive) })
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if len(patches) != 1 || patches[0]["status"] != autopilotActive {
		t.Fatalf("patches = %+v", patches)
	}
	if !strings.Contains(out, "0 22 * * * UTC") {
		t.Fatalf("output missing schedule:\n%s", out)
	}
}

func TestKBDigestCommandsExplainMissingDigest(t *testing.T) {
	var patches []map[string]any
	digestTestServer(t, false, &patches)

	_, err := captureStdout(t, func() error { return setKBDigestStatus(newKBDigestTestCmd(), autopilotPaused) })
	if err == nil || !strings.Contains(err.Error(), "kb digest create") {
		t.Fatalf("err = %v", err)
	}
	if len(patches) != 0 {
		t.Fatalf("unexpected patches %+v", patches)
	}
}
