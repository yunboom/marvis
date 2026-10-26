package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// insertTestKbBase creates a knowledge base in the handler test workspace and
// removes it and everything written under it when the test ends.
func insertTestKbBase(t *testing.T, name, slug string, over ...testutil.Cols) string {
	t.Helper()

	cols := testutil.Cols{
		"workspace_id": testWorkspaceID,
		"name":         name,
		"slug":         slug,
		"description":  name + " description",
		"schema_mode":  kb.SchemaModeDefault,
		"purpose":      "# Purpose",
		"schema":       "# Schema",
		"created_by":   testUserID,
	}
	for _, o := range over {
		for k, v := range o {
			cols[k] = v
		}
	}
	id := dbfx.Insert(t, "kb_base", cols)

	for _, table := range []string{"kb_page", "kb_page_revision", "kb_link", "kb_annotation", "kb_merge_request"} {
		dbfx.Cleanup(t, fmt.Sprintf(`DELETE FROM %s WHERE knowledge_base_id = $1`, table), id)
	}

	return id
}

func createTestKbPage(t *testing.T, baseID string, page kb.NewPage) string {
	t.Helper()

	page.WorkspaceID = testWorkspaceID
	page.KnowledgeBaseID = baseID
	if page.Position == "" {
		page.Position = "a0"
	}
	if page.Type == "" {
		page.Type = "Guide"
	}
	created, err := kb.CreatePage(context.Background(), testHandler.Queries, page)
	if err != nil {
		t.Fatalf("CreatePage(%s): %+v", page.Slug, err)
	}

	return uuidToString(created.ID)
}

func TestListKbBases(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	suffix := time.Now().UnixNano()
	older := insertTestKbBase(t, "Older KB", fmt.Sprintf("older-%d", suffix), testutil.Cols{
		"updated_at": time.Now().Add(-time.Hour),
	})
	newer := insertTestKbBase(t, "Newer KB", fmt.Sprintf("newer-%d", suffix))

	createTestKbPage(t, newer, kb.NewPage{Slug: "quickstart", Reserved: kb.ReservedQuickstart, Title: "Quickstart", Markdown: "intro"})
	overdue := time.Now().Add(-24 * time.Hour)
	createTestKbPage(t, newer, kb.NewPage{Slug: "payment", Title: "Payment", Markdown: "body", StaleAfter: &overdue})
	deleted := createTestKbPage(t, newer, kb.NewPage{Slug: "gone", Title: "Gone", Markdown: "body"})
	dbfx.Exec(t, `UPDATE kb_page SET deleted_at = now() WHERE id = $1`, deleted)

	dbfx.InsertNoID(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": newer, "body": "check this",
		"author_type": "member", "author_id": testUserID, "status": kb.AnnotationStatusPending,
	}, "knowledge_base_id = $1", newer)
	dbfx.InsertNoID(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": newer, "body": "done",
		"author_type": "member", "author_id": testUserID, "status": kb.AnnotationStatusResolved,
	}, "knowledge_base_id = $1", newer)
	dbfx.InsertNoID(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": newer, "number": 1, "title": "Change",
		"source": "custom", "author_type": "member", "author_id": testUserID,
		"draft_id": testutil.Raw("gen_random_uuid()"), "status": kb.MergeRequestStatusOpen,
	}, "knowledge_base_id = $1", newer)

	var got []KbBaseResponse
	testutil.Call(t, testHandler.ListKbBases, newRequest(http.MethodGet, "/api/kb/bases", nil)).
		Want(http.StatusOK).JSON(&got)

	byID := map[string]KbBaseResponse{}
	order := []string{}
	for _, base := range got {
		byID[base.ID] = base
		if base.ID == older || base.ID == newer {
			order = append(order, base.ID)
		}
	}
	if len(order) != 2 || order[0] != newer || order[1] != older {
		t.Fatalf("order = %v, want newer before older", order)
	}

	n := byID[newer]
	if n.PageCount != 1 {
		t.Errorf("page_count = %d, want 1 (quickstart and deleted pages excluded)", n.PageCount)
	}
	if n.Pending != (KbPendingResponse{Annotations: 1, StalePages: 1, OpenMRs: 1}) {
		t.Errorf("pending = %+v, want 1 annotation, 1 stale page, 1 open MR", n.Pending)
	}
	if n.Slug != fmt.Sprintf("newer-%d", suffix) || n.SchemaMode != kb.SchemaModeDefault || n.CreatedBy != testUserID {
		t.Errorf("base = %+v", n)
	}
	if o := byID[older]; o.PageCount != 0 || o.Pending != (KbPendingResponse{}) {
		t.Errorf("older base = %+v, want empty counts", o)
	}
}

func TestListKbBasesOnlyCurrentWorkspace(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	otherWorkspace := dbfx.Workspace(t, "KB Other", fmt.Sprintf("kb-other-%d", time.Now().UnixNano()))
	other := dbfx.Insert(t, "kb_base", testutil.Cols{
		"workspace_id": otherWorkspace, "name": "Other", "slug": "other", "schema_mode": kb.SchemaModeDefault,
		"schema": "# Schema", "created_by": testUserID,
	})

	var got []KbBaseResponse
	testutil.Call(t, testHandler.ListKbBases, newRequest(http.MethodGet, "/api/kb/bases", nil)).
		Want(http.StatusOK).JSON(&got)
	for _, base := range got {
		if base.ID == other {
			t.Fatal("list returned a knowledge base from another workspace")
		}
	}

	req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+other, nil), "kb", other)
	testutil.Call(t, testHandler.GetKbBase, req).Want(http.StatusNotFound)
}

func TestGetKbBase(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("detail-%d", time.Now().UnixNano())
	id := insertTestKbBase(t, "Detail KB", slug, testutil.Cols{"schema_mode": kb.SchemaModeCustom})

	for _, ref := range []string{id, slug} {
		var got KbBaseDetailResponse
		req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+ref, nil), "kb", ref)
		testutil.Call(t, testHandler.GetKbBase, req).Want(http.StatusOK).JSON(&got)
		if got.ID != id || got.Slug != slug || got.Purpose != "# Purpose" || got.Schema != "# Schema" ||
			got.SchemaMode != kb.SchemaModeCustom {
			t.Fatalf("GetKbBase(%s) = %+v", ref, got)
		}
	}

	for _, ref := range []string{"missing-slug", "00000000-0000-0000-0000-000000000001"} {
		req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+ref, nil), "kb", ref)
		testutil.Call(t, testHandler.GetKbBase, req).Want(http.StatusNotFound)
	}
}

func TestCreateKbPageWritesRevisionAndLinks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	base := insertTestKbBase(t, "Links KB", fmt.Sprintf("links-%d", time.Now().UnixNano()))
	payment := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "支付", Markdown: "# 支付\n\n入口"})
	callback := createTestKbPage(t, base, kb.NewPage{
		ParentID: payment,
		Slug:     "callback",
		Title:    "支付回调",
		Markdown: "## 去重\n\n见[支付](/payment.md)和[退款](/payment/refund.md)。",
	})

	var (
		blocks, searchText string
		headMatches        bool
	)
	dbfx.QueryRow(t, `
		SELECT p.blocks::text, p.search_text, p.head_revision_id = r.id
		FROM kb_page p JOIN kb_page_revision r ON r.page_id = p.id
		WHERE p.id = $1`, callback).Scan(&blocks, &searchText, &headMatches)
	if !headMatches {
		t.Fatal("head_revision_id does not point at the page's revision")
	}
	if want := "支付回调\n去重\n见支付和退款。"; searchText != want {
		t.Fatalf("search_text = %q, want %q", searchText, want)
	}

	links, err := testHandler.Queries.ListKbLinksFromPage(context.Background(), db.ListKbLinksFromPageParams{
		KnowledgeBaseID: parseUUID(base),
		FromPageID:      parseUUID(callback),
	})
	if err != nil {
		t.Fatalf("ListKbLinksFromPage: %v", err)
	}
	if len(links) != 2 {
		t.Fatalf("links = %+v, want 2", links)
	}
	resolved, pending := links[0], links[1]
	if resolved.ToPath != "/payment" {
		resolved, pending = pending, resolved
	}
	if uuidToString(resolved.ToPageID) != payment || resolved.ToPath != "/payment" {
		t.Errorf("resolved link = %+v, want to_page_id %s", resolved, payment)
	}
	if pending.ToPageID.Valid || pending.ToPath != "/payment/refund" {
		t.Errorf("unwritten-page link = %+v, want NULL to_page_id and the written path", pending)
	}
	if !strings.Contains(blocks, "kb://"+payment) || !strings.Contains(blocks, "/payment/refund.md") {
		t.Errorf("blocks = %s, want resolved kb:// link and unresolved path kept", blocks)
	}
}
