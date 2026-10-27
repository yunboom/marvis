package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

const (
	larkInviteTestWorkspaceID = "11111111-1111-1111-1111-111111111111"
	larkInviteTestInviteA     = "8f2a3b4c-0000-4000-8000-00000000000a"
	larkInviteTestInviteB     = "9d1e5f60-0000-4000-8000-00000000000b"
	larkInviteTestExpiresAt   = "2026-10-30T06:00:00Z"
)

// larkInviteCall 是桩服务端收到的一次请求。
type larkInviteCall struct {
	Method string
	Path   string
	Query  string
	Body   []byte
}

// larkInviteStub 记录所有请求，撤销是并发发出的，所以加锁。
type larkInviteStub struct {
	mu    sync.Mutex
	calls []larkInviteCall
}

func (s *larkInviteStub) Calls() []larkInviteCall {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]larkInviteCall(nil), s.calls...)
}

// newLarkInviteStub 启动桩服务端并把 CLI 指向它。handle 负责写响应，请求在调用前已记录。
func newLarkInviteStub(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *larkInviteStub {
	t.Helper()

	stub := &larkInviteStub{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}

		stub.mu.Lock()
		stub.calls = append(stub.calls, larkInviteCall{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: body})
		stub.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		handle(w, r, body)
	}))
	t.Cleanup(srv.Close)

	redirectTestHome(t, t.TempDir())
	t.Setenv("MARVIS_SERVER_URL", srv.URL)
	t.Setenv("MARVIS_TOKEN", "test-token")
	t.Setenv("MARVIS_WORKSPACE_ID", larkInviteTestWorkspaceID)

	return stub
}

// larkInviteNoRequest 返回一个任何请求都算失败的桩，用来断言校验先于请求。
func larkInviteNoRequest(t *testing.T) *larkInviteStub {
	t.Helper()

	return newLarkInviteStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.String())
		w.WriteHeader(http.StatusInternalServerError)
	})
}

// runLarkInvite 在独立的命令上执行 args，补上根命令的持久参数，返回标准输出和命令错误。
func runLarkInvite(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()

	cmd.Flags().String("server-url", "", "")
	cmd.Flags().String("workspace-id", "", "")
	cmd.Flags().String("profile", "", "")
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	cmd.SetArgs(args)

	return captureStdout(t, cmd.Execute)
}

func writeLarkInviteJSON(t *testing.T, w http.ResponseWriter, status int, v any) {
	t.Helper()

	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

// decodeLarkInviteBody 把请求体解成 map，便于断言字段是否存在。
func decodeLarkInviteBody(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode request body %q: %v", body, err)
	}

	return got
}

// larkInviteLines 把表格输出按行切开并去掉空行。
func larkInviteLines(out string) []string {
	var lines []string
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}

	return lines
}

func larkInviteSentResult(targetType, targetID, idType, name string) map[string]any {
	return map[string]any{
		"id":     larkInviteTestInviteA,
		"target": map[string]any{"type": targetType, "id": targetID, "id_type": idType, "name": name, "avatar_url": nil},
		"role":   "member", "expires_at": larkInviteTestExpiresAt, "max_uses": nil, "status": "sent", "error": nil,
	}
}

func larkInviteRecordJSON(id, targetID, name, status string, useCount int, maxUses any) map[string]any {
	return map[string]any{
		"id":         id,
		"target":     map[string]any{"type": "chat", "id": targetID, "id_type": "chat_id", "name": name, "avatar_url": nil},
		"role":       "member",
		"status":     status,
		"use_count":  useCount,
		"max_uses":   maxUses,
		"expires_at": larkInviteTestExpiresAt,
		"revoked_at": nil,
		"note":       "",
		"sent_by":    map[string]any{"id": "u1", "name": "Alice", "avatar_url": nil},
		"created_at": "2026-10-23T06:00:00Z",
		"joined":     []any{},
	}
}

func larkInviteExpiresDisplay(t *testing.T) string {
	t.Helper()

	expires, err := time.Parse(time.RFC3339, larkInviteTestExpiresAt)
	if err != nil {
		t.Fatalf("parse expires: %v", err)
	}

	return expires.Local().Format(larkInviteTimeLayout)
}

func TestLarkInviteSend_ChatID(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{
			"results": []any{larkInviteSentResult("chat", "oc_1", "chat_id", "Marvis 内测群")},
		})
	})

	out, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}
	if calls[0].Method != http.MethodPost || calls[0].Path != "/api/workspaces/"+larkInviteTestWorkspaceID+"/lark-invites" {
		t.Fatalf("request = %s %s", calls[0].Method, calls[0].Path)
	}

	body := decodeLarkInviteBody(t, calls[0].Body)
	if ids, _ := body["chat_ids"].([]any); len(ids) != 1 || ids[0] != "oc_1" {
		t.Errorf("chat_ids = %v, want [oc_1]", body["chat_ids"])
	}
	if _, ok := body["user_open_ids"]; ok {
		t.Errorf("user_open_ids = %v, want absent for a chat target", body["user_open_ids"])
	}
	if body["role"] != "member" {
		t.Errorf("role = %v, want member", body["role"])
	}
	if body["expires_in_hours"] != float64(168) {
		t.Errorf("expires_in_hours = %v, want 168", body["expires_in_hours"])
	}
	if body["max_uses"] != float64(0) || body["note"] != "" || body["idempotency_key"] != "" {
		t.Errorf("max_uses/note/idempotency_key = %v/%v/%v, want 0/empty/empty", body["max_uses"], body["note"], body["idempotency_key"])
	}

	lines := larkInviteLines(out)
	if len(lines) != 2 {
		t.Fatalf("output lines = %d, want header and one row:\n%s", len(lines), out)
	}
	if got, want := strings.Fields(lines[0]), []string{"ID", "TYPE", "ROLE", "EXPIRES", "STATUS", "TARGET"}; !equalStrings(got, want) {
		t.Errorf("header = %v, want %v", got, want)
	}
	if !strings.HasPrefix(lines[1], "8f2a3b4c ") || strings.Contains(lines[1], "8f2a3b4c-") {
		t.Errorf("row = %q, want the first 8 characters of the invite id", lines[1])
	}
	if !strings.HasSuffix(lines[1], "Marvis 内测群") {
		t.Errorf("row = %q, want the chat name as the last column", lines[1])
	}
	if !strings.Contains(lines[1], larkInviteExpiresDisplay(t)) || !strings.Contains(lines[1], "sent") {
		t.Errorf("row = %q, want expiry and status", lines[1])
	}
}

func TestLarkInviteSend_UserIDAndFlags(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{
			"results": []any{larkInviteSentResult("user", "ou_1", "open_id", "张三")},
		})
	})

	_, err := runLarkInvite(t, newLarkInviteSendCmd(),
		"--user-id", "ou_1", "--role", "admin", "--max-uses", "3", "--note", "welcome", "--idempotency-key", "k-1")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	body := decodeLarkInviteBody(t, stub.Calls()[0].Body)
	if ids, _ := body["user_open_ids"].([]any); len(ids) != 1 || ids[0] != "ou_1" {
		t.Errorf("user_open_ids = %v, want [ou_1]", body["user_open_ids"])
	}
	if _, ok := body["chat_ids"]; ok {
		t.Errorf("chat_ids = %v, want absent for a user target", body["chat_ids"])
	}
	if body["role"] != "admin" || body["max_uses"] != float64(3) || body["note"] != "welcome" || body["idempotency_key"] != "k-1" {
		t.Errorf("body = %v", body)
	}
}

func TestLarkInviteSend_UsesWorkspaceArgWithoutLookup(t *testing.T) {
	const otherWorkspace = "22222222-2222-2222-2222-222222222222"
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{
			"results": []any{larkInviteSentResult("chat", "oc_1", "chat_id", "群")},
		})
	})

	if _, err := runLarkInvite(t, newLarkInviteSendCmd(), otherWorkspace, "--chat-id", "oc_1"); err != nil {
		t.Fatalf("send: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 1 || calls[0].Path != "/api/workspaces/"+otherWorkspace+"/lark-invites" {
		t.Fatalf("calls = %+v, want one request to the workspace argument", calls)
	}
}

func TestLarkInviteSend_RequiresExactlyOneTarget(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "neither", args: nil},
		{name: "both", args: []string{"--chat-id", "oc_1", "--user-id", "ou_1"}},
		{name: "blank values", args: []string{"--chat-id", " ", "--user-id", ""}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := larkInviteNoRequest(t)

			_, err := runLarkInvite(t, newLarkInviteSendCmd(), tt.args...)
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !strings.Contains(cli.FormatError(err, false), "invalid_target") {
				t.Errorf("error = %q, want the invalid_target code", cli.FormatError(err, false))
			}
			if n := len(stub.Calls()); n != 0 {
				t.Errorf("requests = %d, want 0", n)
			}
		})
	}
}

func TestLarkInviteSend_RejectsBadPrefixes(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "open_id as chat", args: []string{"--chat-id", "ou_x"}},
		{name: "chat id as user", args: []string{"--user-id", "oc_x"}},
		{name: "chat prefix only", args: []string{"--chat-id", "oc_"}},
		{name: "user prefix only", args: []string{"--user-id", "ou_"}},
		{name: "no prefix", args: []string{"--chat-id", "x"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := larkInviteNoRequest(t)

			_, err := runLarkInvite(t, newLarkInviteSendCmd(), tt.args...)
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !strings.Contains(cli.FormatError(err, false), "invalid_target") {
				t.Errorf("error = %q, want the invalid_target code", cli.FormatError(err, false))
			}
			if n := len(stub.Calls()); n != 0 {
				t.Errorf("requests = %d, want 0", n)
			}
		})
	}
}

func TestLarkInviteSend_RejectsInvalidOptionsBeforeRequest(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "role owner", args: []string{"--role", "owner"}, want: "invalid_request"},
		{name: "role unknown", args: []string{"--role", "superuser"}, want: "invalid_request"},
		{name: "idempotency key too long", args: []string{"--idempotency-key", strings.Repeat("k", 51)}, want: "invalid_request"},
		{name: "unknown output", args: []string{"--output", "yaml"}, want: "yaml"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := larkInviteNoRequest(t)

			args := append([]string{"--chat-id", "oc_1"}, tt.args...)
			_, err := runLarkInvite(t, newLarkInviteSendCmd(), args...)
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !strings.Contains(cli.FormatError(err, false), tt.want) {
				t.Errorf("error = %q, want it to contain %q", cli.FormatError(err, false), tt.want)
			}
			if n := len(stub.Calls()); n != 0 {
				t.Errorf("requests = %d, want 0", n)
			}
		})
	}
}

func TestLarkInviteSend_FailedResultExitsNonZero(t *testing.T) {
	failed := map[string]any{
		"id":     nil,
		"target": map[string]any{"type": "chat", "id": "oc_1", "id_type": "chat_id", "name": "", "avatar_url": nil},
		"role":   "member", "expires_at": nil, "max_uses": nil, "status": "failed",
		"error": map[string]any{"code": "bot_not_in_chat", "message": "the Marvis bot is not in this chat"},
	}

	t.Run("table", func(t *testing.T) {
		newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{"results": []any{failed}})
		})

		out, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1")
		if err == nil {
			t.Fatal("expected an error for a failed result, got nil")
		}
		if got, want := cli.FormatError(err, false), "Error: bot_not_in_chat: the Marvis bot is not in this chat"; got != want {
			t.Errorf("error = %q, want %q", got, want)
		}
		if code := cli.ExitCodeFor(err); code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}

		lines := larkInviteLines(out)
		if len(lines) != 2 || !strings.Contains(lines[1], "failed") || !strings.HasSuffix(lines[1], "oc_1") {
			t.Errorf("output = %q, want a failed row that falls back to the target id", out)
		}
	})

	t.Run("json", func(t *testing.T) {
		newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{"results": []any{failed}})
		})

		out, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1", "--output", "json")
		if err == nil || !strings.Contains(err.Error(), "bot_not_in_chat") {
			t.Fatalf("error = %v, want one that contains bot_not_in_chat", err)
		}

		var results []map[string]any
		if jsonErr := json.Unmarshal([]byte(out), &results); jsonErr != nil {
			t.Fatalf("stdout %q is not a JSON array: %v", out, jsonErr)
		}
		errObj, _ := results[0]["error"].(map[string]any)
		if len(results) != 1 || errObj["code"] != "bot_not_in_chat" {
			t.Errorf("results = %v, want the server results array", results)
		}
	})
}

func TestLarkInviteSend_JSONPrintsResultsArray(t *testing.T) {
	newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{
			"results": []any{larkInviteSentResult("chat", "oc_1", "chat_id", "Marvis 内测群")},
		})
	})

	out, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1", "--output", "json")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	var results []map[string]any
	if jsonErr := json.Unmarshal([]byte(out), &results); jsonErr != nil {
		t.Fatalf("stdout %q is not a JSON array: %v", out, jsonErr)
	}
	if len(results) != 1 || results[0]["id"] != larkInviteTestInviteA {
		t.Errorf("results = %v, want the full invite id from the server", results)
	}
}

func TestLarkInviteSend_ServerErrorShowsCode(t *testing.T) {
	newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusForbidden, map[string]string{
			"error": "feishu invites are not configured on this server", "code": "lark_not_configured",
		})
	})

	_, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if got, want := cli.FormatError(err, false), "Error: lark_not_configured: feishu invites are not configured on this server"; got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
	if code := cli.ExitCodeFor(err); code != cli.ExitAuth {
		t.Errorf("exit code = %d, want %d for a 403", code, cli.ExitAuth)
	}
}

func TestLarkInviteSend_ServerErrorWithoutCodeKeepsGenericMessage(t *testing.T) {
	newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusInternalServerError, map[string]string{"error": "boom"})
	})

	_, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if strings.HasPrefix(cli.FormatError(err, false), "Error: ") {
		t.Errorf("error = %q, want no code prefix when the server sent no code", cli.FormatError(err, false))
	}
}

func TestLarkInviteSend_ExpiresInDays(t *testing.T) {
	tests := []struct {
		value string
		hours float64
	}{
		{value: "3d", hours: 72},
		{value: "36h", hours: 36},
		{value: "1h", hours: 1},
		{value: "30d", hours: 720},
		{value: "720h", hours: 720},
	}

	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				writeLarkInviteJSON(t, w, http.StatusOK, map[string]any{
					"results": []any{larkInviteSentResult("chat", "oc_1", "chat_id", "群")},
				})
			})

			if _, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1", "--expires-in", tt.value); err != nil {
				t.Fatalf("send: %v", err)
			}

			body := decodeLarkInviteBody(t, stub.Calls()[0].Body)
			if body["expires_in_hours"] != tt.hours {
				t.Errorf("expires_in_hours = %v, want %v", body["expires_in_hours"], tt.hours)
			}
		})
	}
}

func TestLarkInviteSend_ExpiresInRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"0h", "30m", "90m", "721h", "31d", "0d", "-1h", "abc", "1d12h", "", "99999999999999999999d"} {
		t.Run(value, func(t *testing.T) {
			stub := larkInviteNoRequest(t)

			_, err := runLarkInvite(t, newLarkInviteSendCmd(), "--chat-id", "oc_1", "--expires-in", value)
			if err == nil {
				t.Fatalf("--expires-in %q: expected an error, got nil", value)
			}
			if n := len(stub.Calls()); n != 0 {
				t.Errorf("requests = %d, want 0", n)
			}
		})
	}
}

func TestLarkInviteExpiresValue(t *testing.T) {
	flags := newLarkInviteSendCmd().Flags()
	flag := flags.Lookup("expires-in")
	if flag == nil {
		t.Fatal("--expires-in is not registered")
	}
	if flag.Value.Type() != "duration" {
		t.Errorf("Type() = %q, want duration", flag.Value.Type())
	}
	if flag.DefValue != "168h" {
		t.Errorf("default = %q, want 168h", flag.DefValue)
	}

	if err := flags.Set("expires-in", "7d"); err != nil {
		t.Fatalf("Set(7d): %v", err)
	}
	if got := flag.Value.String(); got != "168h" {
		t.Errorf("String() after 7d = %q, want 168h", got)
	}
}

func TestLarkInviteList_StatusFlag(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, []any{
			larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "Marvis 内测群", "completed", 3, 50),
			larkInviteRecordJSON(larkInviteTestInviteB, "oc_2", "产品群", "completed", 7, nil),
		})
	})

	out, err := runLarkInvite(t, newLarkInviteListCmd(), "--status", "completed")
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 1 || calls[0].Method != http.MethodGet {
		t.Fatalf("calls = %+v, want one GET", calls)
	}
	if calls[0].Path != "/api/workspaces/"+larkInviteTestWorkspaceID+"/lark-invites" || calls[0].Query != "status=completed" {
		t.Errorf("request = %s?%s, want status=completed", calls[0].Path, calls[0].Query)
	}

	lines := larkInviteLines(out)
	if len(lines) != 3 {
		t.Fatalf("output lines = %d, want header and two rows:\n%s", len(lines), out)
	}
	if got, want := strings.Fields(lines[0]), []string{"ID", "TYPE", "ROLE", "JOINED", "EXPIRES", "STATUS", "TARGET"}; !equalStrings(got, want) {
		t.Errorf("header = %v, want %v", got, want)
	}
	if !strings.HasSuffix(lines[1], "Marvis 内测群") || !strings.Contains(lines[1], "3/50") {
		t.Errorf("row 1 = %q, want joined 3/50 and the chat name last", lines[1])
	}
	if !strings.HasSuffix(lines[2], "产品群") || !strings.Contains(lines[2], " 7 ") || strings.Contains(lines[2], "7/") {
		t.Errorf("row 2 = %q, want joined 7 without a limit and the chat name last", lines[2])
	}
}

func TestLarkInviteList_DefaultsToActiveAndFullID(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, []any{larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群", "active", 0, nil)})
	})

	out, err := runLarkInvite(t, newLarkInviteListCmd(), larkInviteTestWorkspaceID, "--full-id")
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	if q := stub.Calls()[0].Query; q != "status=active" {
		t.Errorf("query = %q, want status=active", q)
	}
	if !strings.Contains(out, larkInviteTestInviteA) {
		t.Errorf("output = %q, want the full invite id with --full-id", out)
	}
}

func TestLarkInviteList_RejectsUnknownStatus(t *testing.T) {
	stub := larkInviteNoRequest(t)

	_, err := runLarkInvite(t, newLarkInviteListCmd(), "--status", "pending")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if n := len(stub.Calls()); n != 0 {
		t.Errorf("requests = %d, want 0", n)
	}
}

func TestLarkInviteList_JSONAndEmpty(t *testing.T) {
	t.Run("json passes the server array through", func(t *testing.T) {
		newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeLarkInviteJSON(t, w, http.StatusOK, []any{larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群", "active", 0, nil)})
		})

		out, err := runLarkInvite(t, newLarkInviteListCmd(), "--output", "json")
		if err != nil {
			t.Fatalf("list: %v", err)
		}

		var invites []map[string]any
		if jsonErr := json.Unmarshal([]byte(out), &invites); jsonErr != nil {
			t.Fatalf("stdout %q is not a JSON array: %v", out, jsonErr)
		}
		if len(invites) != 1 || invites[0]["id"] != larkInviteTestInviteA || invites[0]["note"] != "" {
			t.Errorf("invites = %v, want the server array including fields the table hides", invites)
		}
	})

	t.Run("empty table prints no rows", func(t *testing.T) {
		newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeLarkInviteJSON(t, w, http.StatusOK, []any{})
		})

		out, err := runLarkInvite(t, newLarkInviteListCmd())
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if strings.TrimSpace(out) != "" {
			t.Errorf("stdout = %q, want empty", out)
		}
	})
}

func TestLarkInviteGet_FullIDShowsJoinedUsers(t *testing.T) {
	record := larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "Marvis 内测群", "active", 2, nil)
	record["joined"] = []any{
		map[string]any{"user_id": "u1", "name": "张三", "email": "zhang@example.com", "avatar_url": nil, "joined_at": "2026-10-24T01:00:00Z"},
		map[string]any{"user_id": "u2", "name": "Bob", "email": "bob@example.com", "avatar_url": nil, "joined_at": "2026-10-24T02:00:00Z"},
	}
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, record)
	})

	out, err := runLarkInvite(t, newLarkInviteGetCmd(), larkInviteTestInviteA)
	if err != nil {
		t.Fatalf("get: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 1 || calls[0].Method != http.MethodGet || calls[0].Path != "/api/workspaces/"+larkInviteTestWorkspaceID+"/lark-invites/"+larkInviteTestInviteA {
		t.Fatalf("calls = %+v, want one GET of the invite, with no id lookup for a full UUID", calls)
	}
	for _, want := range []string{"Marvis 内测群", "zhang@example.com", "张三", "bob@example.com"} {
		if !strings.Contains(out, want) {
			t.Errorf("output = %q, want it to contain %q", out, want)
		}
	}

	jsonOut, err := runLarkInvite(t, newLarkInviteGetCmd(), larkInviteTestInviteA, "--output", "json")
	if err != nil {
		t.Fatalf("get --output json: %v", err)
	}
	var got map[string]any
	if jsonErr := json.Unmarshal([]byte(jsonOut), &got); jsonErr != nil {
		t.Fatalf("stdout %q is not a JSON object: %v", jsonOut, jsonErr)
	}
	if joined, _ := got["joined"].([]any); len(joined) != 2 {
		t.Errorf("joined = %v, want both joined users", got["joined"])
	}
}

func TestLarkInviteGet_ResolvesShortPrefix(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if strings.HasSuffix(r.URL.Path, "/lark-invites") {
			writeLarkInviteJSON(t, w, http.StatusOK, []any{
				larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群 A", "revoked", 0, nil),
				larkInviteRecordJSON(larkInviteTestInviteB, "oc_2", "群 B", "active", 0, nil),
			})
			return
		}
		writeLarkInviteJSON(t, w, http.StatusOK, larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群 A", "revoked", 0, nil))
	})

	if _, err := runLarkInvite(t, newLarkInviteGetCmd(), "8f2a3b4c"); err != nil {
		t.Fatalf("get: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 2 {
		t.Fatalf("calls = %+v, want a list lookup then the get", calls)
	}
	if calls[0].Query != "status=all" {
		t.Errorf("lookup query = %q, want status=all so revoked and expired invites resolve too", calls[0].Query)
	}
	if calls[1].Path != "/api/workspaces/"+larkInviteTestWorkspaceID+"/lark-invites/"+larkInviteTestInviteA {
		t.Errorf("get path = %q, want the resolved full id", calls[1].Path)
	}
}

func TestLarkInviteGet_UnknownShortPrefix(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, []any{larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群", "active", 0, nil)})
	})

	_, err := runLarkInvite(t, newLarkInviteGetCmd(), "ffff0000")
	if err == nil {
		t.Fatal("expected an error for a prefix that matches no invite, got nil")
	}
	if n := len(stub.Calls()); n != 1 {
		t.Errorf("requests = %d, want only the list lookup", n)
	}
}

func TestLarkInviteGet_NotFoundShowsCode(t *testing.T) {
	newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusNotFound, map[string]string{"error": "invite not found", "code": "invite_not_found"})
	})

	_, err := runLarkInvite(t, newLarkInviteGetCmd(), larkInviteTestInviteA)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if got, want := cli.FormatError(err, false), "Error: invite_not_found: invite not found"; got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
}

func TestLarkInviteRevoke_MultipleIDs(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		writeLarkInviteJSON(t, w, http.StatusOK, larkInviteRecordJSON(id, "oc_"+id[:1], "群 "+id[:1], "revoked", 0, nil))
	})

	out, err := runLarkInvite(t, newLarkInviteRevokeCmd(), larkInviteTestInviteA, larkInviteTestInviteB)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}

	calls := stub.Calls()
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(calls))
	}
	gotPaths := map[string]bool{}
	for _, call := range calls {
		if call.Method != http.MethodDelete {
			t.Errorf("method = %s, want DELETE", call.Method)
		}
		gotPaths[call.Path] = true
	}
	for _, id := range []string{larkInviteTestInviteA, larkInviteTestInviteB} {
		if !gotPaths["/api/workspaces/"+larkInviteTestWorkspaceID+"/lark-invites/"+id] {
			t.Errorf("no DELETE for %s in %v", id, gotPaths)
		}
	}

	lines := larkInviteLines(out)
	if len(lines) != 3 {
		t.Fatalf("output lines = %d, want header and two rows:\n%s", len(lines), out)
	}
	if !strings.HasPrefix(lines[1], "8f2a3b4c ") || !strings.HasPrefix(lines[2], "9d1e5f60 ") {
		t.Errorf("rows = %q / %q, want results in argument order", lines[1], lines[2])
	}
	if !strings.Contains(lines[1], "revoked") || !strings.Contains(lines[2], "revoked") {
		t.Errorf("rows = %q / %q, want the revoked status", lines[1], lines[2])
	}
}

func TestLarkInviteRevoke_PartialFailureExitsNonZero(t *testing.T) {
	newLarkInviteStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if strings.HasSuffix(r.URL.Path, larkInviteTestInviteB) {
			writeLarkInviteJSON(t, w, http.StatusNotFound, map[string]string{"error": "invite not found", "code": "invite_not_found"})
			return
		}
		writeLarkInviteJSON(t, w, http.StatusOK, larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群 A", "revoked", 0, nil))
	})

	out, err := runLarkInvite(t, newLarkInviteRevokeCmd(), larkInviteTestInviteA, larkInviteTestInviteB, "--output", "json")
	if err == nil {
		t.Fatal("expected an error when one revoke fails, got nil")
	}

	message := cli.FormatError(err, false)
	if !strings.Contains(message, "Error: invite_not_found: invite not found") || !strings.Contains(message, larkInviteTestInviteB) {
		t.Errorf("error = %q, want the code, message and failing invite id", message)
	}

	var revoked []map[string]any
	if jsonErr := json.Unmarshal([]byte(out), &revoked); jsonErr != nil {
		t.Fatalf("stdout %q is not a JSON array: %v", out, jsonErr)
	}
	if len(revoked) != 1 || revoked[0]["id"] != larkInviteTestInviteA {
		t.Errorf("revoked = %v, want only the invite that was revoked", revoked)
	}
}

func TestLarkInviteRevoke_DeduplicatesIDs(t *testing.T) {
	stub := newLarkInviteStub(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeLarkInviteJSON(t, w, http.StatusOK, larkInviteRecordJSON(larkInviteTestInviteA, "oc_1", "群", "revoked", 0, nil))
	})

	if _, err := runLarkInvite(t, newLarkInviteRevokeCmd(), larkInviteTestInviteA, larkInviteTestInviteA); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if n := len(stub.Calls()); n != 1 {
		t.Errorf("requests = %d, want 1 for a repeated id", n)
	}
}

func TestLarkInviteRevoke_RequiresAnID(t *testing.T) {
	stub := larkInviteNoRequest(t)

	if _, err := runLarkInvite(t, newLarkInviteRevokeCmd()); err == nil {
		t.Fatal("expected an error without an invite id, got nil")
	}
	if n := len(stub.Calls()); n != 0 {
		t.Errorf("requests = %d, want 0", n)
	}
}

func TestLarkInviteCommandIsMountedUnderWorkspace(t *testing.T) {
	cmd, _, err := workspaceCmd.Find([]string{"lark-invite", "send"})
	if err != nil || cmd == nil || cmd.Name() != "send" {
		t.Fatalf("workspace lark-invite send not found: cmd=%v err=%v", cmd, err)
	}
	for _, name := range []string{"list", "get", "revoke"} {
		if cmd, _, err := workspaceCmd.Find([]string{"lark-invite", name}); err != nil || cmd == nil || cmd.Name() != name {
			t.Errorf("workspace lark-invite %s not found: cmd=%v err=%v", name, cmd, err)
		}
	}
}

func TestLarkInviteSendHelpTextIsVerbatim(t *testing.T) {
	flags := newLarkInviteSendCmd().Flags()

	want := map[string]string{
		"chat-id": "(required, mutually exclusive with --user-id) chat ID (oc_xxx)",
		"user-id": "(required, mutually exclusive with --chat-id) user open_id (ou_xxx)",
	}
	for name, usage := range want {
		flag := flags.Lookup(name)
		if flag == nil || flag.Usage != usage {
			t.Errorf("--%s usage = %v, want %q", name, flag, usage)
		}
	}
}

// TestLarkInviteHelpListsErrorCodes 确认 get、revoke 的帮助写明失败时的错误码，含 invite_not_found。
func TestLarkInviteHelpListsErrorCodes(t *testing.T) {
	for _, cmd := range []*cobra.Command{newLarkInviteGetCmd(), newLarkInviteRevokeCmd()} {
		for _, code := range []string{"lark_not_configured", "permission_denied", "invite_not_found"} {
			if !strings.Contains(cmd.Long, code) {
				t.Errorf("%s help does not list %s:\n%s", cmd.Name(), code, cmd.Long)
			}
		}
	}
}

// TestLarkInviteHelpExplainsNotConfigured 确认 lark-invite 和 send 的帮助写明 lark_not_configured 也覆盖
// 飞书应用没开机器人或缺权限的情况。
func TestLarkInviteHelpExplainsNotConfigured(t *testing.T) {
	for _, cmd := range []*cobra.Command{newLarkInviteCmd(), newLarkInviteSendCmd()} {
		for _, want := range []string{"lark_not_configured", "bot ability off", "permission scope"} {
			if !strings.Contains(cmd.Long, want) {
				t.Errorf("%s help does not mention %q:\n%s", cmd.Name(), want, cmd.Long)
			}
		}
	}
}

// TestLarkInviteIdempotencyKeyHelpStatesWindow 确认 --idempotency-key 的帮助写明 1 小时的重放窗口和之后的失败码。
func TestLarkInviteIdempotencyKeyHelpStatesWindow(t *testing.T) {
	flag := newLarkInviteSendCmd().Flags().Lookup(larkInviteFlagIdempotencyKey)
	if flag == nil {
		t.Fatal("--idempotency-key not registered")
	}
	for _, want := range []string{"1 hour", "invalid_request", "50 characters"} {
		if !strings.Contains(flag.Usage, want) {
			t.Errorf("--idempotency-key usage %q does not mention %q", flag.Usage, want)
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}

	return true
}
