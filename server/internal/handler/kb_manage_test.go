package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/storage"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// keyRecordingStorage is a mockStorage that reports the keys it is asked to
// delete; DeleteKbBase must not ask.
type keyRecordingStorage struct {
	mockStorage
	deleted chan []string
}

func (s *keyRecordingStorage) DeleteKeys(_ context.Context, keys []string) {
	s.deleted <- keys
}

func installKbStorage(t *testing.T, store storage.Storage) {
	t.Helper()

	origStorage, origCfg, origSigner := testHandler.Storage, testHandler.cfg, testHandler.CFSigner
	testHandler.Storage = store
	testHandler.CFSigner = nil
	t.Cleanup(func() {
		testHandler.Storage, testHandler.cfg, testHandler.CFSigner = origStorage, origCfg, origSigner
	})
}

// kbRawUploadRequest builds a multipart upload of files (name → content).
func kbRawUploadRequest(t *testing.T, userID, baseID, kind string, files ...[2]string) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if kind != "" {
		if err := writer.WriteField("kind", kind); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range files {
		part, err := writer.CreateFormFile("file", file[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(file[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/kb/bases/"+baseID+"/raw", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-User-ID", userID)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)

	return testutil.WithURLParams(req, "kb", baseID)
}

func kbRawContentRequest(rawID, query string) *http.Request {
	req := newRequest(http.MethodGet, "/api/kb/raw/"+rawID+"/content?"+query, nil)

	return testutil.WithURLParams(req, "id", rawID)
}

// TestKbRawUpload: any member uploads; names are unique per kind; the list
// counts the pages citing each file.
func TestKbRawUpload(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	store := &mockStorage{}
	installKbStorage(t, store)
	base := insertTestKbBase(t, "Raw KB", fmt.Sprintf("raw-%d", time.Now().UnixNano()))
	plain := createPlainMember(t, fmt.Sprintf("kb-raw-%d@marvis.ai", time.Now().UnixNano()))

	var uploaded KbRawUploadResponse
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, base, "",
		[2]string{"渠道接入规范 v3.pdf", "%PDF-1.4 spec"},
		[2]string{"notes.md", "# notes"},
	)).Want(http.StatusCreated).JSON(&uploaded)
	if len(uploaded.Files) != 2 {
		t.Fatalf("files = %+v", uploaded.Files)
	}
	spec := uploaded.Files[0]
	if spec.Name != "渠道接入规范 v3.pdf" || spec.Kind != kb.RawKindSource || spec.URI != "raw://sources/渠道接入规范 v3.pdf" || spec.Size != 13 {
		t.Errorf("spec = %+v", spec)
	}
	var key string
	dbfx.QueryRow(t, `SELECT storage_key FROM kb_raw WHERE id = $1`, spec.ID).Scan(&key)
	if !strings.HasPrefix(key, "workspaces/"+testWorkspaceID+"/kb/"+base+"/") || !strings.HasSuffix(key, ".pdf") {
		t.Errorf("storage key = %q", key)
	}
	if got := string(store.files[key]); got != "%PDF-1.4 spec" {
		t.Errorf("stored bytes = %q", got)
	}

	// Same name again is refused, an asset may share it, a bad kind is 400.
	conflict := testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, base, kb.RawKindSource,
		[2]string{"notes.md", "again"},
	)).Want(http.StatusConflict).Map()
	if conflict["code"] != kbCodeRawNameTaken {
		t.Errorf("conflict = %v", conflict)
	}
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, base, kb.RawKindAsset,
		[2]string{"notes.md", "asset"},
	)).Want(http.StatusCreated)
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, base, "other",
		[2]string{"x.md", "x"},
	)).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, base, "",
		[2]string{"a.md", "1"}, [2]string{"a.md", "2"},
	)).Want(http.StatusConflict)

	// A member of another workspace does not find the knowledge base.
	other := insertTestKbBase(t, "Elsewhere", fmt.Sprintf("raw-else-%d", time.Now().UnixNano()), testutil.Cols{"workspace_id": uuid.NewString()})
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, plain, other, "", [2]string{"x.md", "x"})).Want(http.StatusNotFound)

	// Citations: two pages cite the spec (one with #page=), a deleted page does not count.
	cite := func(deleted bool) {
		page := createTestKbPage(t, base, kb.NewPage{Slug: fmt.Sprintf("p-%d", time.Now().UnixNano()), Title: "P", Markdown: "Body."})
		if deleted {
			dbfx.Exec(t, `UPDATE kb_page SET deleted_at = now() WHERE id = $1`, page)
		}
		dbfx.Insert(t, "kb_claim", testutil.Cols{
			"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": page, "block_id": "b1", "key": "c1",
			"text": "t", "checked_at": time.Now(),
			"evidence": `[{"source":"s","uri":"raw://sources/渠道接入规范%20v3.pdf#page=3"},{"source":"t","uri":"raw://sources/渠道接入规范 v3.pdf"}]`,
		})
	}
	cite(false)
	cite(false)
	cite(true)

	var list []KbRawFileListItem
	listReq := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/bases/"+base+"/raw?kind=source", nil), "kb", base)
	testutil.Call(t, testHandler.ListKbRaw, listReq).Want(http.StatusOK).JSON(&list)
	if len(list) != 2 {
		t.Fatalf("list = %+v", list)
	}
	byName := map[string]KbRawFileListItem{}
	for _, item := range list {
		byName[item.Name] = item
	}
	if got := byName["渠道接入规范 v3.pdf"]; got.CitedPages != 2 || got.UploadedBy != plain || got.UploadedByName == "" || got.ContentType != "application/pdf" {
		t.Errorf("spec row = %+v", got)
	}
	if got := byName["notes.md"]; got.CitedPages != 0 {
		t.Errorf("notes row = %+v", got)
	}
}

// TestKbRawContent: the content endpoint redirects to a signed URL, forces a
// download on request, streams in proxy mode and hands out capability URLs
// that work without credentials.
func TestKbRawContent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	store := &mockStorage{}
	installKbStorage(t, store)
	base := insertTestKbBase(t, "Content KB", fmt.Sprintf("content-%d", time.Now().UnixNano()))
	var uploaded KbRawUploadResponse
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, testUserID, base, "", [2]string{"spec.pdf", "%PDF-1.4 body"})).
		Want(http.StatusCreated).JSON(&uploaded)
	rawID := uploaded.Files[0].ID

	// Presign mode: 302 to the signed URL; download=1 signs an attachment.
	w := httptest.NewRecorder()
	testHandler.GetKbRawContent(w, kbRawContentRequest(rawID, ""))
	if w.Code != http.StatusFound || !strings.HasPrefix(w.Header().Get("Location"), "https://signed.example.com/workspaces/") {
		t.Fatalf("redirect = %d %q", w.Code, w.Header().Get("Location"))
	}
	w = httptest.NewRecorder()
	testHandler.GetKbRawContent(w, kbRawContentRequest(rawID, "download=1"))
	if location, _ := url.Parse(w.Header().Get("Location")); w.Code != http.StatusFound ||
		!strings.HasPrefix(location.Query().Get("response-content-disposition"), "attachment") {
		t.Errorf("download redirect = %d %q", w.Code, w.Header().Get("Location"))
	}
	var signed KbRawContentURLResponse
	testutil.Call(t, testHandler.GetKbRawContent, kbRawContentRequest(rawID, "format=url")).Want(http.StatusOK).JSON(&signed)
	if !strings.HasPrefix(signed.URL, "https://signed.example.com/") {
		t.Errorf("format=url = %q", signed.URL)
	}

	// Another workspace's id is not found.
	foreign := newRequest(http.MethodGet, "/api/kb/raw/"+rawID+"/content", nil)
	foreign.Header.Set("X-Workspace-ID", uuid.NewString())
	testutil.Call(t, testHandler.GetKbRawContent, testutil.WithURLParams(foreign, "id", rawID)).Want(http.StatusNotFound)

	// Proxy mode: the bytes come through the API, and format=url answers a
	// capability that the public route accepts without credentials.
	testHandler.cfg.AttachmentDownloadMode = "proxy"
	w = httptest.NewRecorder()
	testHandler.GetKbRawContent(w, kbRawContentRequest(rawID, ""))
	if w.Code != http.StatusOK || w.Body.String() != "%PDF-1.4 body" || w.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("proxy = %d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
	}

	for _, download := range []bool{false, true} {
		query := "format=url"
		if download {
			query += "&download=1"
		}
		var capability KbRawContentURLResponse
		testutil.Call(t, testHandler.GetKbRawContent, kbRawContentRequest(rawID, query)).Want(http.StatusOK).JSON(&capability)
		if !strings.HasPrefix(capability.URL, "/api/kb/raw/"+rawID+"/signed-content?") {
			t.Fatalf("capability = %q", capability.URL)
		}

		public := httptest.NewRequest(http.MethodGet, capability.URL, nil)
		w = httptest.NewRecorder()
		testHandler.GetKbRawContentWithCapability(w, testutil.WithURLParams(public, "id", rawID))
		disposition := w.Header().Get("Content-Disposition")
		if w.Code != http.StatusOK || w.Body.String() != "%PDF-1.4 body" || strings.HasPrefix(disposition, "attachment") != download {
			t.Errorf("capability download=%v = %d %q %q", download, w.Code, w.Body.String(), disposition)
		}

		// The signature is bound to the file and the intent.
		tampered := strings.Replace(capability.URL, "&sig=", "&sig=00", 1)
		w = httptest.NewRecorder()
		testHandler.GetKbRawContentWithCapability(w, testutil.WithURLParams(httptest.NewRequest(http.MethodGet, tampered, nil), "id", rawID))
		if w.Code != http.StatusForbidden {
			t.Errorf("tampered = %d", w.Code)
		}
	}

	// An attachment capability does not open a raw file of the same id.
	attachmentPath := attachmentCapabilityPath(rawID, time.Now())
	w = httptest.NewRecorder()
	testHandler.GetKbRawContentWithCapability(w, testutil.WithURLParams(httptest.NewRequest(http.MethodGet, attachmentPath, nil), "id", rawID))
	if w.Code != http.StatusForbidden {
		t.Errorf("attachment capability = %d", w.Code)
	}
}

// TestKbPageRoutesRawLinks: raw:// links and images of a page body point at
// the content endpoint when the file exists.
func TestKbPageRoutesRawLinks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	base := insertTestKbBase(t, "Raw links KB", fmt.Sprintf("rawlinks-%d", time.Now().UnixNano()))
	page := createTestKbPage(t, base, kb.NewPage{Slug: "p", Title: "P", Markdown: "见[规范](raw://sources/spec.pdf#page=4)，![图](raw://assets/flow.png)，[缺](raw://sources/none.pdf)。"})
	spec := dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindSource, "name": "spec.pdf",
		"storage_key": "k1", "size": 1, "content_type": "application/pdf", "uploaded_by": testUserID,
	})
	flow := dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindAsset, "name": "flow.png",
		"storage_key": "k2", "size": 1, "content_type": "image/png", "uploaded_by": testUserID,
	})

	got := getKbPage(t, page, "", http.StatusOK)
	want := "见[规范](/api/kb/raw/" + spec + "/content#page=4)，![图](/api/kb/raw/" + flow + "/content)，[缺](raw://sources/none.pdf)。"
	if len(got.Blocks) != 1 || got.Blocks[0].Content != want {
		t.Errorf("blocks = %+v, want %q", got.Blocks, want)
	}
}

// TestKbExport: the export is an OKF zip with the bundle layout, page links
// made relative, claims files and raw files copied from storage.
func TestKbExport(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	store := &mockStorage{}
	installKbStorage(t, store)
	slug := fmt.Sprintf("export-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Export KB", slug)
	payment := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "支付", Position: "a0", Markdown: "支付总览"})
	idem := createTestKbPage(t, base, kb.NewPage{ParentID: payment, Slug: "idempotency", Title: "幂等键", Position: "a1", Markdown: "## 去重\n\n按交易号去重。"})
	callback := createTestKbPage(t, base, kb.NewPage{
		ParentID: payment, Slug: "callback", Title: "支付回调", Position: "a0",
		Frontmatter: map[string]any{"type": "Workflow", "title": "支付回调"},
		Markdown:    "见[去重](/payment/idempotency.md)与[规范](raw://sources/spec.pdf#page=2)。",
	})
	dbfx.Insert(t, "kb_claim", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": callback, "block_id": "b1", "key": "c1",
		"text": "t", "checked_at": time.Now(), "evidence": `[{"source":"s","uri":"raw://sources/spec.pdf#page=2"}]`,
	})
	testutil.Call(t, testHandler.UploadKbRaw, kbRawUploadRequest(t, testUserID, base, "", [2]string{"spec.pdf", "%PDF-1.4 x"})).Want(http.StatusCreated)

	w := httptest.NewRecorder()
	testHandler.ExportKb(w, testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/bases/"+slug+"/export", nil), "kb", slug))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") != `attachment; filename="`+slug+`.zip"` {
		t.Fatalf("export = %d %q", w.Code, w.Header().Get("Content-Disposition"))
	}

	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	files := map[string]string{}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, _ := io.ReadAll(reader)
		_ = reader.Close()
		files[file.Name] = string(content)
	}

	for _, name := range []string{
		slug + "/PURPOSE.md", slug + "/SCHEMA.md", slug + "/wiki/index.md", slug + "/wiki/payment.md",
		slug + "/wiki/payment/index.md", slug + "/wiki/payment/callback.md", slug + "/wiki/payment/idempotency.md",
		slug + "/wiki/.claims/payment/callback.json", slug + "/raw/sources/spec.pdf",
	} {
		if _, ok := files[name]; !ok {
			t.Errorf("missing %s; got %d files", name, len(files))
		}
	}
	if got := files[slug+"/raw/sources/spec.pdf"]; got != "%PDF-1.4 x" {
		t.Errorf("raw file = %q", got)
	}
	cb := files[slug+"/wiki/payment/callback.md"]
	for _, want := range []string{"marvis_id: " + callback, "](idempotency.md)", "](../../raw/sources/spec.pdf#page=2)"} {
		if !strings.Contains(cb, want) {
			t.Errorf("callback.md lacks %q:\n%s", want, cb)
		}
	}
	if !strings.Contains(files[slug+"/wiki/payment/index.md"], "- [支付回调](callback.md)\n- [幂等键](idempotency.md)") {
		t.Errorf("payment index = %q", files[slug+"/wiki/payment/index.md"])
	}
	_ = idem
}

// TestKbGraph: nodes are live pages plus linked paths not yet written; edges
// come from kb_link.
func TestKbGraph(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("graph-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Graph KB", slug)
	payment := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "支付", Markdown: "总览"})
	callback := createTestKbPage(t, base, kb.NewPage{ParentID: payment, Slug: "callback", Title: "支付回调", Markdown: "见[总览](/payment.md)和[退款](/payment/refund.md)。"})
	gone := createTestKbPage(t, base, kb.NewPage{Slug: "gone", Title: "已删", Markdown: "见[回调](/payment/callback.md)。"})
	dbfx.Exec(t, `UPDATE kb_page SET deleted_at = now() WHERE id = $1`, gone)
	createTestKbPage(t, base, kb.NewPage{Slug: "lone", Title: "孤立", Markdown: "无链接"})

	var graph KbGraphResponse
	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/bases/"+slug+"/graph", nil), "kb", slug)
	testutil.Call(t, testHandler.GetKbGraph, req).Want(http.StatusOK).JSON(&graph)

	byKey := map[string]KbGraphNodeResponse{}
	for _, node := range graph.Nodes {
		byKey[node.Key] = node
	}
	if len(graph.Nodes) != 4 || len(graph.Edges) != 2 {
		t.Fatalf("graph = %+v", graph)
	}
	if node := byKey[callback]; node.ID == nil || *node.ID != callback || node.Group != "支付" || node.Degree != 2 {
		t.Errorf("callback = %+v", node)
	}
	if node := byKey["/payment/refund"]; node.ID != nil || !node.Missing || node.Title != "/payment/refund" || node.Group != "支付" {
		t.Errorf("missing = %+v", node)
	}
	for _, node := range graph.Nodes {
		if node.Title == "孤立" && node.Degree != 0 {
			t.Errorf("lone = %+v", node)
		}
	}
}

// kbTablesWithBase lists every kb table and how to count its rows of one
// knowledge base; DeleteKbBase must keep all of them.
var kbTablesWithBase = map[string]string{
	"kb_base":            `SELECT count(*) FROM kb_base WHERE id = $1`,
	"kb_config_revision": `SELECT count(*) FROM kb_config_revision WHERE knowledge_base_id = $1`,
	"kb_builder_session": `SELECT count(*) FROM kb_builder_session WHERE knowledge_base_id = $1`,
	"kb_raw":             `SELECT count(*) FROM kb_raw WHERE knowledge_base_id = $1`,
	"kb_page":            `SELECT count(*) FROM kb_page WHERE knowledge_base_id = $1`,
	"kb_page_revision":   `SELECT count(*) FROM kb_page_revision WHERE knowledge_base_id = $1`,
	"kb_claim":           `SELECT count(*) FROM kb_claim WHERE knowledge_base_id = $1`,
	"kb_link":            `SELECT count(*) FROM kb_link WHERE knowledge_base_id = $1`,
	"kb_draft":           `SELECT count(*) FROM kb_draft WHERE knowledge_base_id = $1`,
	"kb_draft_page":      `SELECT count(*) FROM kb_draft_page WHERE draft_id IN (SELECT id FROM kb_draft WHERE knowledge_base_id = $1) OR page_id IN (SELECT id FROM kb_page WHERE knowledge_base_id = $1)`,
	"kb_job":             `SELECT count(*) FROM kb_job WHERE knowledge_base_id = $1`,
	"kb_job_draft":       `SELECT count(*) FROM kb_job_draft WHERE job_id IN (SELECT id FROM kb_job WHERE knowledge_base_id = $1)`,
	"kb_annotation":      `SELECT count(*) FROM kb_annotation WHERE knowledge_base_id = $1`,
	"kb_merge_request":   `SELECT count(*) FROM kb_merge_request WHERE knowledge_base_id = $1`,
	"kb_mr_comment":      `SELECT count(*) FROM kb_mr_comment WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`,
	"kb_mr_review":       `SELECT count(*) FROM kb_mr_review WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`,
	"kb_mr_event":        `SELECT count(*) FROM kb_mr_event WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`,
	"kb_block_embedding": `SELECT count(*) FROM kb_block_embedding WHERE knowledge_base_id = $1`,
}

// seedKbEverywhere writes one row of base into every kb table and returns the
// child rows that are keyed through a parent (draft page, job draft, comment)
// so their counts can be checked by id.
func seedKbEverywhere(t *testing.T, base string, number int) {
	t.Helper()

	page := createTestKbPage(t, base, kb.NewPage{Slug: fmt.Sprintf("seed-%d", number), Title: "Seed", Markdown: "Seed [x](/elsewhere.md)."})
	dbfx.Insert(t, "kb_config_revision", testutil.Cols{
		"knowledge_base_id": base, "name": "n", "description": "", "schema_mode": kb.SchemaModeDefault,
		"purpose": "", "schema": "", "saved_by": testUserID,
	})
	session := uuid.NewString()
	dbfx.InsertNoID(t, "kb_builder_session", testutil.Cols{
		"chat_session_id": session, "workspace_id": testWorkspaceID, "mode": "config", "knowledge_base_id": base,
	}, "chat_session_id = $1", session)
	dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindSource, "name": fmt.Sprintf("f-%d.pdf", number),
		"storage_key": fmt.Sprintf("workspaces/x/kb/%s/f-%d.pdf", base, number), "size": 1, "content_type": "application/pdf", "uploaded_by": testUserID,
	})
	dbfx.Insert(t, "kb_claim", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": page, "block_id": "b1", "key": "c1",
		"text": "t", "checked_at": time.Now(), "evidence": `[]`,
	})
	draft := dbfx.Insert(t, "kb_draft", testutil.Cols{"workspace_id": testWorkspaceID, "knowledge_base_id": base, "created_by": testUserID})
	dbfx.InsertNoID(t, "kb_draft_page", testutil.Cols{
		"draft_id": draft, "page_id": page, "op": kb.DraftOpUpdate, "position": "a0", "slug": "s",
		"frontmatter": `{}`, "blocks": `[]`, "claims": `[]`,
	}, "draft_id = $1", draft)
	job := dbfx.Insert(t, "kb_job", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "name": "job", "starter": "custom",
		"agent_id": uuid.NewString(), "chat_session_id": uuid.NewString(), "created_by": testUserID,
	})
	dbfx.Insert(t, "kb_job_draft", testutil.Cols{"workspace_id": testWorkspaceID, "job_id": job, "draft_id": draft, "created_by": testUserID})
	dbfx.Insert(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "body": "b", "author_type": "member", "author_id": testUserID,
	})
	mr := dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "number": number, "title": "t", "source": "custom",
		"author_type": "member", "author_id": testUserID, "draft_id": draft,
	})
	dbfx.Insert(t, "kb_mr_comment", testutil.Cols{"merge_request_id": mr, "body": "c", "author_type": "member", "author_id": testUserID})
	dbfx.Insert(t, "kb_mr_review", testutil.Cols{"workspace_id": testWorkspaceID, "merge_request_id": mr, "reviewer_user_id": testUserID})
	dbfx.Insert(t, "kb_mr_event", testutil.Cols{
		"workspace_id": testWorkspaceID, "merge_request_id": mr, "actor_type": "member", "actor_id": testUserID, "kind": "edited",
	})

	var hasEmbeddings bool
	dbfx.QueryRow(t, `SELECT to_regclass('public.kb_block_embedding') IS NOT NULL`).Scan(&hasEmbeddings)
	if hasEmbeddings {
		vector := "[" + strings.TrimSuffix(strings.Repeat("0,", 1024), ",") + "]"
		dbfx.InsertNoID(t, "kb_block_embedding", testutil.Cols{
			"page_id": page, "block_id": "b1", "knowledge_base_id": base, "workspace_id": testWorkspaceID,
			"content_hash": "h", "model": "m", "embedding": vector,
		}, "page_id = $1", page)
	}
}

func countKbRows(t *testing.T, base string) map[string]int {
	t.Helper()

	var hasEmbeddings bool
	dbfx.QueryRow(t, `SELECT to_regclass('public.kb_block_embedding') IS NOT NULL`).Scan(&hasEmbeddings)
	counts := map[string]int{}
	for table, query := range kbTablesWithBase {
		if table == "kb_block_embedding" && !hasEmbeddings {
			continue
		}
		var n int
		dbfx.QueryRow(t, query, base).Scan(&n)
		counts[table] = n
	}

	return counts
}

// TestDeleteKbBase: only the creator or an owner / admin deletes, by name.
// The delete is soft: every kb row and raw object stays, active merge
// requests are closed, the knowledge base disappears from every read and its
// slug can be taken again.
func TestDeleteKbBase(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	// Every knowledge base table (but the workspace counter) is checked.
	rows, err := testPool.Query(context.Background(), `SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name LIKE 'kb\_%' AND table_name <> 'kb_workspace'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		if _, ok := kbTablesWithBase[table]; !ok {
			t.Errorf("table %s is not covered by the deletion check", table)
		}
	}
	rows.Close()

	store := &keyRecordingStorage{deleted: make(chan []string, 1)}
	installKbStorage(t, store)
	suffix := time.Now().UnixNano()
	creator := createPlainMember(t, fmt.Sprintf("kb-del-creator-%d@marvis.ai", suffix))
	plain := createPlainMember(t, fmt.Sprintf("kb-del-plain-%d@marvis.ai", suffix))
	slug := fmt.Sprintf("del-%d", suffix)
	word := fmt.Sprintf("softdel%d", suffix)
	base := insertTestKbBase(t, "要删除的知识库", slug, testutil.Cols{"created_by": creator})
	keep := insertTestKbBase(t, "保留的知识库", fmt.Sprintf("keep-%d", suffix))
	number := int(suffix%1_000_000) + 2_000_000
	seedKbEverywhere(t, base, number)
	seedKbEverywhere(t, keep, number+1)
	createTestKbPage(t, base, kb.NewPage{Slug: "findme", Title: "Find " + word, Position: "a5", Markdown: "Body " + word + "."})
	baseBefore := countKbRows(t, base)
	keepBefore := countKbRows(t, keep)
	var rawID, jobID, draftID, annotationID string
	dbfx.QueryRow(t, `SELECT id FROM kb_raw WHERE knowledge_base_id = $1`, base).Scan(&rawID)
	dbfx.QueryRow(t, `SELECT id FROM kb_job WHERE knowledge_base_id = $1`, base).Scan(&jobID)
	dbfx.QueryRow(t, `SELECT id FROM kb_draft WHERE knowledge_base_id = $1`, base).Scan(&draftID)
	dbfx.QueryRow(t, `SELECT id FROM kb_annotation WHERE knowledge_base_id = $1`, base).Scan(&annotationID)

	searchWord := func() KbSearchResponse {
		var search KbSearchResponse
		testutil.Call(t, testHandler.SearchKb, newRequest(http.MethodGet, "/api/kb/search?q="+word, nil)).Want(http.StatusOK).JSON(&search)
		return search
	}
	if before := searchWord(); before.Total != 1 {
		t.Fatalf("search before delete = %+v", before)
	}

	deleteReq := func(userID, name string) *http.Request {
		req := newRequestAs(userID, http.MethodDelete, "/api/kb/bases/"+slug, map[string]any{"confirm_name": name})
		return testutil.WithURLParams(req, "kb", slug)
	}
	testutil.Call(t, testHandler.DeleteKbBase, deleteReq(plain, "要删除的知识库")).Want(http.StatusForbidden)
	mismatch := testutil.Call(t, testHandler.DeleteKbBase, deleteReq(creator, "要删除")).Want(http.StatusBadRequest).Map()
	if mismatch["code"] != kbCodeConfirmMismatch {
		t.Errorf("mismatch = %v", mismatch)
	}

	var resp DeleteKbBaseResponse
	testutil.Call(t, testHandler.DeleteKbBase, deleteReq(creator, "要删除的知识库")).Want(http.StatusOK).JSON(&resp)
	if !resp.Deleted || len(resp.ClosedMRs) != 1 || int(resp.ClosedMRs[0]) != number {
		t.Errorf("response = %+v", resp)
	}

	t.Run("rows and raw objects stay", func(t *testing.T) {
		for table, n := range countKbRows(t, base) {
			if n != baseBefore[table] {
				t.Errorf("%s rows of the deleted knowledge base: %d, want %d", table, n, baseBefore[table])
			}
		}
		for table, n := range countKbRows(t, keep) {
			if n != keepBefore[table] {
				t.Errorf("%s rows of the other knowledge base: %d, want %d", table, n, keepBefore[table])
			}
		}
		select {
		case keys := <-store.deleted:
			t.Errorf("raw objects deleted from storage: %v", keys)
		default:
		}

		var deletedBy, status, closedBy string
		var deleted bool
		dbfx.QueryRow(t, `SELECT deleted_at IS NOT NULL, COALESCE(deleted_by::text, '') FROM kb_base WHERE id = $1`, base).Scan(&deleted, &deletedBy)
		if !deleted || deletedBy != creator {
			t.Errorf("deleted = %v by %q, want by %s", deleted, deletedBy, creator)
		}
		dbfx.QueryRow(t, `SELECT status, COALESCE(closed_by::text, '') FROM kb_merge_request WHERE knowledge_base_id = $1`, base).Scan(&status, &closedBy)
		if status != kb.MergeRequestStatusClosed || closedBy != creator {
			t.Errorf("merge request = %s by %q, want closed by %s", status, closedBy, creator)
		}
	})

	t.Run("gone from every read", func(t *testing.T) {
		for _, ref := range []string{slug, base} {
			req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+ref, nil), "kb", ref)
			testutil.Call(t, testHandler.GetKbBase, req).Want(http.StatusNotFound)
		}
		testutil.Call(t, testHandler.DeleteKbBase, deleteReq(creator, "要删除的知识库")).Want(http.StatusNotFound)

		var list []KbBaseResponse
		testutil.Call(t, testHandler.ListKbBases, newRequest(http.MethodGet, "/api/kb/bases", nil)).Want(http.StatusOK).JSON(&list)
		listed := false
		for _, b := range list {
			listed = listed || b.ID == base
		}
		if listed {
			t.Error("the deleted knowledge base is listed")
		}

		briefs, _, err := testHandler.taskKnowledgeBases(context.Background(), parseUUID(testWorkspaceID))
		if err != nil {
			t.Fatal(err)
		}
		for _, b := range briefs {
			if b.Slug == slug {
				t.Error("the deleted knowledge base is on the task brief")
			}
		}

		if search := searchWord(); len(search.Hits) != 0 || search.Total != 0 {
			t.Errorf("search across knowledge bases = %+v", search)
		}

		var mrs []KbMergeRequestResponse
		req := newRequest(http.MethodGet, "/api/kb/merge-requests?status=all&limit=200", nil)
		testutil.Call(t, testHandler.ListKbMergeRequests, req).Want(http.StatusOK).JSON(&mrs)
		for _, mr := range mrs {
			if mr.Number == number {
				t.Error("a merge request of the deleted knowledge base is listed")
			}
		}
		testutil.Call(t, testHandler.GetKbMergeRequest, kbMRRequest(http.MethodGet, number, nil, nil)).Want(http.StatusNotFound)
		testutil.Call(t, testHandler.GetKbRawContent, kbRawContentRequest(rawID, "")).Want(http.StatusNotFound)
		getKbJob(t, jobID, nil, http.StatusNotFound)
		testutil.Call(t, testHandler.GetKbDraft, testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/drafts/x", nil), "draftId", draftID)).
			Want(http.StatusNotFound)
		testutil.Call(t, testHandler.GetKbAnnotation, testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/annotations/x", nil), "id", annotationID)).
			Want(http.StatusNotFound)
	})

	t.Run("slug is free again", func(t *testing.T) {
		created := createKbBaseRequest(t, map[string]any{
			"name": "重建的知识库", "slug": slug, "schema_mode": kb.SchemaModeDefault,
		}, http.StatusCreated)
		var got KbBaseDetailResponse
		req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+slug, nil), "kb", slug)
		testutil.Call(t, testHandler.GetKbBase, req).Want(http.StatusOK).JSON(&got)
		if got.ID != created.ID || got.ID == base {
			t.Errorf("slug resolves to %s, want the new knowledge base %s", got.ID, created.ID)
		}
	})
}
