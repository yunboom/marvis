package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/yunboom/marvis/server/internal/cli"
)

// kbTestRequest is one request the fake server saw.
type kbTestRequest struct {
	Method string
	Path   string
	Query  map[string]string
	Body   map[string]any
}

// newKbTestServer answers every request with status and body and records
// what it received.
func newKbTestServer(t *testing.T, status int, body any) *[]kbTestRequest {
	t.Helper()

	seen := &[]kbTestRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := kbTestRequest{Method: r.Method, Path: r.URL.EscapedPath(), Query: map[string]string{}}
		for k, v := range r.URL.Query() {
			req.Query[k] = v[0]
		}
		_ = json.NewDecoder(r.Body).Decode(&req.Body)
		*seen = append(*seen, req)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	setCLITestServerEnv(t, srv.URL)

	return seen
}

// runKbTestCmd resets a command's flags, parses args and runs it, returning
// what it printed.
func runKbTestCmd(t *testing.T, c *cobra.Command, args ...string) (string, error) {
	t.Helper()

	c.Flags().VisitAll(func(f *pflag.Flag) {
		if sv, ok := f.Value.(pflag.SliceValue); ok {
			_ = sv.Replace(nil)
		} else {
			_ = f.Value.Set(f.DefValue)
		}
		f.Changed = false
	})
	if err := c.ParseFlags(args); err != nil {
		t.Fatalf("parse flags %v: %v", args, err)
	}

	return captureStdout(t, func() error { return c.RunE(c, c.Flags().Args()) })
}

func TestKbDraftCreateRequest(t *testing.T) {
	seen := newKbTestServer(t, http.StatusCreated, map[string]any{"id": "d1", "version": 0, "status": "open"})

	out, err := runKbTestCmd(t, kbDraftCreateCmd, "team", "--title", "Daily")
	if err != nil {
		t.Fatalf("draft create: %v", err)
	}
	req := (*seen)[0]
	if req.Method != http.MethodPost || req.Path != "/api/kb/drafts" ||
		req.Body["knowledge_base"] != "team" || req.Body["title"] != "Daily" {
		t.Errorf("request = %+v", req)
	}
	if _, ok := req.Body["job_id"]; ok {
		t.Errorf("job_id sent: %+v", req.Body)
	}
	if !strings.Contains(out, `"id": "d1"`) {
		t.Errorf("output = %s", out)
	}
}

func TestKbPagePatchSetMeta(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"version": "d2"})

	_, err := runKbTestCmd(t, kbPagePatchCmd, "team:/payment/callback", "--draft", "d1", "--version", "d1", "--op", "set_meta",
		"--meta", "status=stable", "tags=[\"dev\",\"qa\"]", "stale_after=")
	if err != nil {
		t.Fatalf("patch: %v", err)
	}

	req := (*seen)[0]
	if req.Path != "/api/kb/drafts/d1/pages/team:%2Fpayment%2Fcallback/ops" || req.Body["version"] != "d1" {
		t.Fatalf("request = %+v", req)
	}
	op := req.Body["ops"].([]any)[0].(map[string]any)
	fields := op["fields"].(map[string]any)
	if op["op"] != "set_meta" || fields["status"] != "stable" || len(fields["tags"].([]any)) != 2 {
		t.Errorf("op = %+v", op)
	}
	if v, ok := fields["stale_after"]; !ok || v != nil {
		t.Errorf("empty value should remove the key: %+v", fields)
	}

	if _, err := runKbTestCmd(t, kbPagePatchCmd, "p", "--draft", "d1", "--version", "d1", "--op", "block_replace", "extra=1"); err == nil {
		t.Error("key=value arguments accepted outside set_meta")
	}
	if _, err := runKbTestCmd(t, kbPagePatchCmd, "p", "--draft", "d1", "--version", "d1", "--op", "block_replace", "--block", "b1"); err == nil {
		t.Error("block_replace without content accepted")
	}
}

func TestKbPagePatchPrintsErrorCode(t *testing.T) {
	newKbTestServer(t, http.StatusConflict, map[string]any{"error": "the page changed after you read it", "code": "stale_version"})

	out, err := runKbTestCmd(t, kbPagePatchCmd, "p", "--draft", "d1", "--version", "d1", "--op", "append", "--content", "x")
	if !errors.Is(err, errSilent) {
		t.Fatalf("err = %v, want it already printed", err)
	}
	if cli.ExitCodeFor(err) == 0 {
		t.Error("exit code 0 on a failed write")
	}

	var body kbErrorBody
	if jsonErr := json.Unmarshal([]byte(out), &body); jsonErr != nil || body.Error.Code != "stale_version" || body.Error.Message == "" {
		t.Errorf("output = %s", out)
	}
}

func TestKbPageListPassesPagingAndType(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{
		"version": 3, "total": 7, "next_cursor": "abc",
		"pages": []map[string]any{{"id": "33445566-7788-499a-8bbc-cddeeff00112", "path": "/a", "title": "A", "type": "Runbook", "child_count": 0}},
	})

	out, err := runKbTestCmd(t, kbPageListCmd, "team", "--parent", "team:/ops", "--limit", "20", "--cursor", "xyz", "--type", "Runbook")
	if err != nil {
		t.Fatalf("page list: %v", err)
	}
	q := (*seen)[0].Query
	if (*seen)[0].Path != "/api/kb/bases/team/pages" || q["parent"] != "team:/ops" || q["limit"] != "20" || q["cursor"] != "xyz" || q["type"] != "Runbook" {
		t.Errorf("request = %+v", (*seen)[0])
	}
	for _, want := range []string{"33445566", "/a", "total: 7", "next_cursor: abc"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q:\n%s", want, out)
		}
	}

	if _, err := runKbTestCmd(t, kbPageListCmd, "team", "--limit", "201"); err == nil {
		t.Error("--limit 201 accepted")
	}
}

func TestKbPageFetchQuery(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"version": "d9", "content": "# A"})

	_, err := runKbTestCmd(t, kbPageFetchCmd, "team:/payment/callback", "--scope", "section", "--start-block-id", "b7Kq",
		"--detail", "with-ids", "--draft", "d1", "--context-after", "1", "--backlinks")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	req := (*seen)[0]
	if req.Path != "/api/kb/pages/team:%2Fpayment%2Fcallback/fetch" {
		t.Errorf("path = %s", req.Path)
	}
	want := map[string]string{"scope": "section", "start_block_id": "b7Kq", "detail": "with-ids", "draft": "d1", "context_after": "1", "backlinks": "true"}
	for k, v := range want {
		if req.Query[k] != v {
			t.Errorf("query %s = %q, want %q", k, req.Query[k], v)
		}
	}
	if _, ok := req.Query["context_before"]; ok {
		t.Error("unset --context-before was sent")
	}

	if _, err := runKbTestCmd(t, kbPageFetchCmd, "p", "--draft", "d1", "--revision-id", "r1"); err == nil {
		t.Error("--draft with --revision-id accepted")
	}
}

func TestKbDraftCheckAndSyncExitCodes(t *testing.T) {
	newKbTestServer(t, http.StatusOK, map[string]any{
		"id": "d1", "checks": map[string]any{"lint": []map[string]any{{"code": "missing_type", "severity": "error"}}, "conflicts": []any{}},
	})
	if _, err := runKbTestCmd(t, kbDraftCheckCmd, "d1"); !errors.Is(err, errSilent) {
		t.Errorf("check with an error = %v, want a non-zero exit", err)
	}

	newKbTestServer(t, http.StatusOK, map[string]any{
		"id": "d1", "checks": map[string]any{"lint": []map[string]any{{"code": "orphan_page", "severity": "warning"}}, "conflicts": []any{}},
	})
	if _, err := runKbTestCmd(t, kbDraftCheckCmd, "d1"); err != nil {
		t.Errorf("check with warnings only = %v", err)
	}

	seen := newKbTestServer(t, http.StatusOK, map[string]any{"version": 13, "unresolved": 1, "pages": []any{}})
	if _, err := runKbTestCmd(t, kbDraftSyncCmd, "d1"); !errors.Is(err, errSilent) {
		t.Errorf("sync with conflicts = %v, want a non-zero exit", err)
	}
	if (*seen)[0].Method != http.MethodPost || (*seen)[0].Path != "/api/kb/drafts/d1/sync" {
		t.Errorf("sync request = %+v", (*seen)[0])
	}
}

func TestKbClaimsSetReadsFile(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"version": "d12"})
	dir := t.TempDir()
	t.Chdir(dir)
	claims := `{"page_id":"p","claims":[{"key":"c1","block_id":"b1","text":"t","evidence":[]}]}`
	if err := os.WriteFile(filepath.Join(dir, "claims.json"), []byte(claims), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := runKbTestCmd(t, kbClaimsSetCmd, "team:/a", "--draft", "d1", "--version", "d11", "--file", "claims.json"); err != nil {
		t.Fatalf("claims set: %v", err)
	}
	req := (*seen)[0]
	if req.Method != http.MethodPut || req.Path != "/api/kb/drafts/d1/pages/team:%2Fa/claims" || len(req.Body["claims"].([]any)) != 1 {
		t.Errorf("request = %+v", req)
	}
}

func TestKbSearchAndChatQueries(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"mode": "keyword", "total": 1, "hits": []any{}})
	if _, err := runKbTestCmd(t, kbSearchCmd, "回调 去重", "--kb", "team", "--type", "Runbook", "--limit", "5", "--output", "json"); err != nil {
		t.Fatalf("search: %v", err)
	}
	if q := (*seen)[0].Query; q["q"] != "回调 去重" || q["kb"] != "team" || q["type"] != "Runbook" || q["limit"] != "5" {
		t.Errorf("search query = %+v", q)
	}
	if kbSearchCmd.Flags().Lookup("offset") != nil || kbSearchCmd.Flags().Lookup("cursor") != nil {
		t.Error("kb search must not page")
	}

	newKbTestServer(t, http.StatusOK, map[string]any{"mode": "hybrid", "total": 3, "hits": []any{
		map[string]any{"page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", "slug": "team", "path": "/pay", "title": "Pay", "excerpt": "dedup", "score": 0.03},
	}})
	out, err := runKbTestCmd(t, kbSearchCmd, "dedup")
	if err != nil {
		t.Fatalf("search table: %v", err)
	}
	if !strings.Contains(out, "mode: hybrid  total: 3") || !strings.Contains(out, "team:/pay") {
		t.Errorf("table output = %q", out)
	}

	seen = newKbTestServer(t, http.StatusOK, []any{})
	if _, err := runKbTestCmd(t, chatListCmd, "--scope", "workspace", "--agent", "11111111-1111-4111-8111-111111111111", "--since", "2026-10-24T00:00:00Z"); err != nil {
		t.Fatalf("chat list: %v", err)
	}
	if q := (*seen)[0].Query; (*seen)[0].Path != "/api/chat/sessions" || q["scope"] != "workspace" || q["agent_id"] != "11111111-1111-4111-8111-111111111111" || q["since"] != "2026-10-24T00:00:00Z" {
		t.Errorf("chat list request = %+v", (*seen)[0])
	}

	seen = newKbTestServer(t, http.StatusOK, map[string]any{"messages": []any{}})
	if _, err := runKbTestCmd(t, chatGetCmd, "s1", "--scope", "workspace", "--limit", "100"); err != nil {
		t.Fatalf("chat get: %v", err)
	}
	if q := (*seen)[0].Query; (*seen)[0].Path != "/api/chat/sessions/s1/messages/page" || q["scope"] != "workspace" || q["limit"] != "100" {
		t.Errorf("chat get request = %+v", (*seen)[0])
	}
}

func TestKbDraftFlagHelp(t *testing.T) {
	for _, c := range []*cobra.Command{kbPageListCmd, kbPageFetchCmd, kbPageCreateCmd, kbPagePatchCmd, kbPageMoveCmd, kbPageDeleteCmd, kbClaimsGetCmd, kbClaimsSetCmd, kbMRCreateCmd} {
		if usage := c.Flags().Lookup("draft").Usage; !strings.HasPrefix(usage, kbDraftFlagHelp) {
			t.Errorf("%s --draft help = %q", c.CommandPath(), usage)
		}
	}
	if !strings.Contains(kbDraftCreateCmd.Long, "One merge request has one draft") || kbDraftCreateCmd.Flags().Lookup("job") != nil {
		t.Errorf("kb draft create help = %q", kbDraftCreateCmd.Long)
	}
}

// The annotation commands send what the annotation endpoints read: the page
// as a reference under "page", list filters as status / page, and the new
// status of dismiss / reopen.
func TestKbAnnotationRequests(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"id": "a1", "status": "pending"})

	if _, err := runKbTestCmd(t, kbAnnotationAddCmd, "team", "--page", "team:/payment/callback", "--block", "b8Xz",
		"--quote", "渠道回调按订单号加幂等键去重。", "--body", "去重键已改"); err != nil {
		t.Fatalf("annotation add: %v", err)
	}
	add := (*seen)[0]
	if add.Method != http.MethodPost || add.Path != "/api/kb/bases/team/annotations" ||
		add.Body["page"] != "team:/payment/callback" || add.Body["block_id"] != "b8Xz" ||
		add.Body["quote"] != "渠道回调按订单号加幂等键去重。" || add.Body["body"] != "去重键已改" {
		t.Errorf("add request = %+v", add)
	}

	if _, err := runKbTestCmd(t, kbAnnotationAddCmd, "team", "--block", "b8Xz", "--body", "x"); err == nil {
		t.Error("--block without --page accepted")
	}

	if _, err := runKbTestCmd(t, kbAnnotationListCmd, "team", "--status", "all", "--page", "-"); err != nil {
		t.Fatalf("annotation list: %v", err)
	}
	if list := (*seen)[1]; list.Method != http.MethodGet || list.Query["status"] != "all" || list.Query["page"] != "-" {
		t.Errorf("list request = %+v", list)
	}

	for name, c := range map[string]struct {
		cmd    *cobra.Command
		status string
	}{"dismiss": {kbAnnotationDismissCmd, "dismissed"}, "reopen": {kbAnnotationReopenCmd, "pending"}} {
		before := len(*seen)
		if _, err := runKbTestCmd(t, c.cmd, "a1"); err != nil {
			t.Fatalf("annotation %s: %v", name, err)
		}
		if req := (*seen)[before]; req.Method != http.MethodPatch || req.Path != "/api/kb/annotations/a1" || req.Body["status"] != c.status {
			t.Errorf("%s request = %+v", name, req)
		}
	}
}

// TestKbMRCommentListShowsPublishedFeedback: comment list reads the
// published comments and the submitted reviews with their summaries.
func TestKbMRCommentListShowsPublishedFeedback(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, []map[string]any{
		{"id": "r1", "state": "submitted", "summary": "Fix the key.", "reviewer_name": "Wang", "body": "Say why."},
		{"id": "r2", "state": "pending", "summary": "", "body": "draft"},
	})

	out, err := runKbTestCmd(t, kbMRCommentListCmd, "16")
	if err != nil {
		t.Fatalf("comment list: %v", err)
	}
	if len(*seen) != 2 || (*seen)[0].Path != "/api/kb/merge-requests/16/comments" || (*seen)[0].Query["state"] != "published" ||
		(*seen)[1].Path != "/api/kb/merge-requests/16/reviews" {
		t.Fatalf("requests = %+v", *seen)
	}

	var got struct {
		Reviews  []map[string]any `json:"reviews"`
		Comments []map[string]any `json:"comments"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output %s: %v", out, err)
	}
	if len(got.Reviews) != 1 || got.Reviews[0]["summary"] != "Fix the key." || len(got.Comments) != 2 {
		t.Errorf("output = %+v", got)
	}
}

func TestKbMRReadyAndListDefaults(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{"number": 16, "status": "open"})

	if _, err := runKbTestCmd(t, kbMRReadyCmd, "16"); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if req := (*seen)[0]; req.Method != http.MethodPost || req.Path != "/api/kb/merge-requests/16/ready" {
		t.Errorf("ready request = %+v", req)
	}

	if _, err := runKbTestCmd(t, kbMRListCmd); err != nil {
		t.Fatalf("list: %v", err)
	}
	if _, ok := (*seen)[1].Query["status"]; ok {
		t.Errorf("list sends a status by default: %+v", (*seen)[1])
	}

	if _, err := runKbTestCmd(t, kbMRCommentAddCmd, "16", "--content", "done"); err == nil {
		t.Error("comment add without --parent accepted")
	}
	if _, err := runKbTestCmd(t, kbMRCommentAddCmd, "16", "--content", "done", "--parent", "c1"); err != nil {
		t.Fatalf("comment add: %v", err)
	}
	if req := (*seen)[2]; req.Path != "/api/kb/merge-requests/16/comments" || req.Body["parent_id"] != "c1" || req.Body["body"] != "done" {
		t.Errorf("comment add request = %+v", req)
	}
}
