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

	for _, table := range []string{
		"kb_page", "kb_page_revision", "kb_link", "kb_annotation", "kb_merge_request",
		"kb_claim", "kb_raw", "kb_job", "kb_draft",
	} {
		dbfx.Cleanup(t, fmt.Sprintf(`DELETE FROM %s WHERE knowledge_base_id = $1`, table), id)
	}
	// Registered last so they run before kb_draft is emptied.
	dbfx.Cleanup(t, `DELETE FROM kb_job_draft WHERE draft_id IN (SELECT id FROM kb_draft WHERE knowledge_base_id = $1)`, id)
	dbfx.Cleanup(t, `DELETE FROM kb_draft_page WHERE draft_id IN (SELECT id FROM kb_draft WHERE knowledge_base_id = $1)`, id)

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
		t.Errorf("page_count = %d, want 1 (deleted pages excluded)", n.PageCount)
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

// Knowledge base tables have no foreign keys, so workspace teardown must sweep
// every one of them itself.
func TestDeleteWorkspaceRemovesKnowledgeBases(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	wsID := dbfx.Workspace(t, "KB Teardown", fmt.Sprintf("kb-teardown-%d", time.Now().UnixNano()))
	dbfx.Exec(t, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, wsID, testUserID)

	var baseID string
	dbfx.QueryRow(t, `
		INSERT INTO kb_base (workspace_id, name, slug, schema_mode, schema, created_by)
		VALUES ($1, 'Teardown', 'teardown', 'default', '# Schema', $2) RETURNING id`, wsID, testUserID).Scan(&baseID)
	if _, err := kb.CreatePage(context.Background(), testHandler.Queries, kb.NewPage{
		WorkspaceID: wsID, KnowledgeBaseID: baseID, Position: "a0", Slug: "intro",
		Type: "Guide", Title: "Intro", Markdown: "see [x](/missing.md)",
	}); err != nil {
		t.Fatalf("CreatePage: %+v", err)
	}
	dbfx.Exec(t, `
		WITH d AS (
			INSERT INTO kb_draft (workspace_id, knowledge_base_id, created_by) VALUES ($1, $2, $3) RETURNING id
		), dp AS (
			INSERT INTO kb_draft_page (draft_id, page_id, op, position, slug, frontmatter, blocks, claims)
			SELECT id, gen_random_uuid(), 'create', 'a1', 'new', '{}', '[]', '[]' FROM d
		), mr AS (
			INSERT INTO kb_merge_request (workspace_id, number, knowledge_base_id, title, source, author_type, author_id, draft_id)
			SELECT $1, 1, $2, 'Change', 'custom', 'member', $3, id FROM d RETURNING id
		), c AS (
			INSERT INTO kb_mr_comment (merge_request_id, body, author_type, author_id)
			SELECT id, 'ok', 'member', $3 FROM mr
		), j AS (
			INSERT INTO kb_job (workspace_id, knowledge_base_id, name, starter, agent_id, chat_session_id, created_by)
			VALUES ($1, $2, 'Job', 'custom', gen_random_uuid(), gen_random_uuid(), $3) RETURNING id
		), jd AS (
			INSERT INTO kb_job_draft (workspace_id, job_id, draft_id, created_by)
			SELECT $1, j.id, d.id, $3 FROM j, d
		)
		INSERT INTO kb_config_revision (knowledge_base_id, name, description, schema_mode, purpose, schema, saved_by)
		VALUES ($2, 'Teardown', '', 'default', '', '# Schema', $3)`, wsID, baseID, testUserID)
	dbfx.Exec(t, `
		WITH a AS (
			INSERT INTO kb_annotation (workspace_id, knowledge_base_id, body, author_type, author_id)
			VALUES ($1, $2, 'note', 'member', $3)
		), r AS (
			INSERT INTO kb_raw (workspace_id, knowledge_base_id, kind, name, storage_key, size, content_type, uploaded_by)
			VALUES ($1, $2, 'source', 'a.pdf', 'kb/a.pdf', 1, 'application/pdf', $3)
		), b AS (
			INSERT INTO kb_builder_session (chat_session_id, workspace_id, mode) VALUES (gen_random_uuid(), $1, 'create')
		), cl AS (
			INSERT INTO kb_claim (workspace_id, knowledge_base_id, page_id, block_id, key, text, evidence, checked_at)
			VALUES ($1, $2, gen_random_uuid(), 'b000', 'c1', 'fact', '[]', now())
		)
		INSERT INTO kb_workspace (workspace_id) VALUES ($1)`, wsID, baseID, testUserID)

	req := withURLParam(newRequest(http.MethodDelete, "/api/workspaces/"+wsID, nil), "id", wsID)
	testutil.Call(t, testHandler.DeleteWorkspace, req).Want(http.StatusNoContent)

	for _, table := range []string{
		"kb_base", "kb_page", "kb_page_revision", "kb_link", "kb_draft", "kb_merge_request", "kb_job",
		"kb_job_draft", "kb_annotation", "kb_raw", "kb_builder_session", "kb_claim",
	} {
		if n := dbfx.Count(t, fmt.Sprintf(`SELECT count(*) FROM %s WHERE workspace_id = $1`, table), wsID); n != 0 {
			t.Errorf("%s still has %d rows after workspace delete", table, n)
		}
	}
	for table, sql := range map[string]string{
		"kb_workspace":       `SELECT count(*) FROM kb_workspace WHERE workspace_id = $1`,
		"kb_config_revision": `SELECT count(*) FROM kb_config_revision WHERE knowledge_base_id = $1`,
		"kb_draft_page":      `SELECT count(*) FROM kb_draft_page dp WHERE NOT EXISTS (SELECT 1 FROM kb_draft d WHERE d.id = dp.draft_id)`,
		"kb_mr_comment":      `SELECT count(*) FROM kb_mr_comment c WHERE NOT EXISTS (SELECT 1 FROM kb_merge_request m WHERE m.id = c.merge_request_id)`,
	} {
		arg := wsID
		if table == "kb_config_revision" {
			arg = baseID
		}
		query := sql
		if !strings.Contains(sql, "$1") {
			if n := dbfx.Count(t, query); n != 0 {
				t.Errorf("%s has %d orphaned rows after workspace delete", table, n)
			}
			continue
		}
		if n := dbfx.Count(t, query, arg); n != 0 {
			t.Errorf("%s still has %d rows after workspace delete", table, n)
		}
	}
}
