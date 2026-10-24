package handler

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExportKnowledgeBaseReturnsOnlyItsDirectory(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")
	seedKnowledgePages(t, wsID, ownerID, map[string]string{
		"team/wiki/concepts/refund.md": "# Refund\n",
		"other/wiki/concepts/x.md":     "# X\n",
	})

	rec := httptest.NewRecorder()
	testHandler.ExportKnowledgeBase(rec, kbRequest(memberID, wsID, http.MethodGet, "/api/knowledge/bases/team/archive", nil, "id", "team"))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("status = %d type = %q body = %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="team.zip"` {
		t.Fatalf("Content-Disposition = %q", got)
	}

	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = string(b)
	}
	if files["team/wiki/concepts/refund.md"] != "# Refund\n" || files["team/AGENTS.md"] == "" {
		t.Fatalf("zip is missing knowledge base files: %v", keysOf(files))
	}
	for name := range files {
		if !strings.HasPrefix(name, "team/") {
			t.Fatalf("zip contains a file outside the knowledge base: %s", name)
		}
	}

	missing := httptest.NewRecorder()
	testHandler.ExportKnowledgeBase(missing, kbRequest(memberID, wsID, http.MethodGet, "/api/knowledge/bases/missing/archive", nil, "id", "missing"))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing knowledge base status = %d", missing.Code)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}

	return out
}
