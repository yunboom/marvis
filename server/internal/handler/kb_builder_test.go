package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// cleanupKbBuilders removes every knowledge base builder carrier (its chat
// sessions cascade) and builder row in the fixture workspace.
func cleanupKbBuilders(t *testing.T) {
	t.Helper()
	dbfx.Cleanup(t, `DELETE FROM agent WHERE workspace_id = $1 AND kind = 'system' AND system_key LIKE 'kb\_builder:%'`, testWorkspaceID)
	dbfx.Cleanup(t, `DELETE FROM kb_builder_session WHERE workspace_id = $1`, testWorkspaceID)
}

func startKbBuilder(t *testing.T, body map[string]any) CreateKbBuilderSessionResponse {
	t.Helper()
	cleanupKbBuilders(t)
	if _, ok := body["runtime_id"]; !ok {
		body["runtime_id"] = testRuntimeID
	}

	var created CreateKbBuilderSessionResponse
	testutil.Call(t, testHandler.CreateKbBuilderSession, newRequest(http.MethodPost, "/api/kb/builder/sessions", body)).
		Want(http.StatusCreated).JSON(&created)

	return created
}

func listKbBuilders(t *testing.T, query string) []KbBuilderSessionResponse {
	t.Helper()
	var got []KbBuilderSessionResponse
	testutil.Call(t, testHandler.ListKbBuilderSessions, newRequest(http.MethodGet, "/api/kb/builder/sessions?"+query, nil)).
		Want(http.StatusOK).JSON(&got)

	return got
}

func findKbBuilder(sessions []KbBuilderSessionResponse, id string) *KbBuilderSessionResponse {
	for i := range sessions {
		if sessions[i].SessionID == id {
			return &sessions[i]
		}
	}

	return nil
}

func kbBuilderRequest(method, sessionID, suffix string, body any) *http.Request {
	return withURLParam(newRequest(method, "/api/kb/builder/sessions/"+sessionID+suffix, body), "sessionId", sessionID)
}

func TestKbBuilderSessionLifecycle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	created := startKbBuilder(t, map[string]any{"mode": kb.BuilderModeCreate, "model": "m-1"})
	if created.RuntimeID != testRuntimeID {
		t.Errorf("runtime_id = %q, want %q", created.RuntimeID, testRuntimeID)
	}

	// A hidden, session-scoped carrier whose instructions are the builder's.
	var kind, systemKey, instructions, model string
	dbfx.QueryRow(t, `SELECT kind, system_key, instructions, model FROM agent WHERE id = $1`, created.BuilderAgentID).
		Scan(&kind, &systemKey, &instructions, &model)
	if kind != "system" || !strings.HasPrefix(systemKey, kb.BuilderSystemKeyPrefix) || model != "m-1" {
		t.Errorf("carrier kind=%q system_key=%q model=%q", kind, systemKey, model)
	}
	if !strings.Contains(instructions, "- Mode: create") || !strings.Contains(instructions, "Schema mode at start: default") {
		t.Errorf("carrier instructions are not the create-mode builder instructions")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_builder_session WHERE chat_session_id = $1 AND mode = 'create' AND knowledge_base_id IS NULL`, created.SessionID); n != 1 {
		t.Fatalf("kb_builder_session rows = %d, want 1", n)
	}
	assertChatSessionSource(t, created.SessionID, protocol.ChatSessionSourceKbBuilder)

	// Untouched conversations are not unfinished drafts.
	if findKbBuilder(listKbBuilders(t, ""), created.SessionID) != nil {
		t.Fatalf("an untouched session must not be listed")
	}

	draft := map[string]any{"name": "支付排障手册", "schema_mode": "default", "applied_message_id": "m-1"}
	testutil.Call(t, testHandler.SaveKbBuilderDraft, kbBuilderRequest(http.MethodPut, created.SessionID, "/draft", map[string]any{"draft": draft})).
		Want(http.StatusNoContent)
	insertChatMessage(t, created.SessionID, "assistant", `好的。<kb_draft>{"name":"支付排障手册"}</kb_draft>`)

	row := findKbBuilder(listKbBuilders(t, "mode=create"), created.SessionID)
	if row == nil {
		t.Fatalf("saved session missing from the create list")
	}
	var stored map[string]any
	if err := json.Unmarshal(row.Draft, &stored); err != nil || stored["name"] != "支付排障手册" {
		t.Errorf("draft = %s (%v)", row.Draft, err)
	}
	if row.Mode != kb.BuilderModeCreate || row.KnowledgeBaseID != nil || row.RuntimeID != testRuntimeID ||
		row.LastMessageRole != "assistant" || !strings.Contains(row.LastMessageContent, "<kb_draft>") || row.LastMessageAt == nil {
		t.Errorf("row = %+v", row)
	}
	if findKbBuilder(listKbBuilders(t, "mode=config"), created.SessionID) != nil {
		t.Errorf("a create session must not be listed under config")
	}
	testutil.Call(t, testHandler.ListKbBuilderSessions, newRequest(http.MethodGet, "/api/kb/builder/sessions?mode=bogus", nil)).
		Want(http.StatusBadRequest)

	// Runtime switch rebinds the carrier.
	other := newTestRuntime(t, "KB Builder Switch Target", "online")
	var switched SwitchKbBuilderRuntimeResponse
	testutil.Call(t, testHandler.SwitchKbBuilderRuntime, kbBuilderRequest(http.MethodPatch, created.SessionID, "/runtime", map[string]any{"runtime_id": other})).
		Want(http.StatusOK).JSON(&switched)
	if switched.RuntimeID != other || switched.SessionID != created.SessionID {
		t.Errorf("switch = %+v", switched)
	}
	if row := findKbBuilder(listKbBuilders(t, ""), created.SessionID); row == nil || row.RuntimeID != other {
		t.Errorf("list must follow the carrier's runtime: %+v", row)
	}
	offline := newTestRuntime(t, "KB Builder Offline", "offline")
	testutil.Call(t, testHandler.SwitchKbBuilderRuntime, kbBuilderRequest(http.MethodPatch, created.SessionID, "/runtime", map[string]any{"runtime_id": offline})).
		Want(http.StatusConflict)

	// Discard removes the conversation, its carrier and its builder row.
	testutil.Call(t, testHandler.DeleteKbBuilderSession, withChatTestWorkspaceCtx(t, kbBuilderRequest(http.MethodDelete, created.SessionID, "", nil))).
		Want(http.StatusNoContent)
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_builder_session WHERE chat_session_id = $1`, created.SessionID); n != 0 {
		t.Errorf("kb_builder_session rows after discard = %d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent WHERE id = $1`, created.BuilderAgentID); n != 0 {
		t.Errorf("carrier rows after discard = %d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE id = $1`, created.SessionID); n != 0 {
		t.Errorf("chat sessions after discard = %d", n)
	}
}

func TestCreateKbBuilderSessionValidation(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	cleanupKbBuilders(t)

	slug := fmt.Sprintf("builder-cfg-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Builder Config KB", slug, testutil.Cols{"schema_mode": kb.SchemaModeCustom})

	create := func(body map[string]any, want int) {
		t.Helper()
		body["runtime_id"] = testRuntimeID
		testutil.Call(t, testHandler.CreateKbBuilderSession, newRequest(http.MethodPost, "/api/kb/builder/sessions", body)).Want(want)
	}
	create(map[string]any{"mode": "edit"}, http.StatusBadRequest)
	create(map[string]any{"mode": kb.BuilderModeCreate, "schema_mode": "fancy"}, http.StatusBadRequest)
	create(map[string]any{"mode": kb.BuilderModeCreate, "knowledge_base_id": base}, http.StatusBadRequest)
	create(map[string]any{"mode": kb.BuilderModeConfig}, http.StatusBadRequest)
	create(map[string]any{"mode": kb.BuilderModeConfig, "knowledge_base_id": "missing-kb"}, http.StatusNotFound)

	// Configuring needs the creator or an owner / admin.
	plain := dbfx.User(t, "KB Builder Plain", fmt.Sprintf("kb-builder-plain-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, plain, "member")
	testutil.Call(t, testHandler.CreateKbBuilderSession, newRequestAs(plain, http.MethodPost, "/api/kb/builder/sessions", map[string]any{
		"mode": kb.BuilderModeConfig, "knowledge_base_id": base, "runtime_id": testRuntimeID,
	})).Want(http.StatusForbidden)

	// The owner configures by slug; the schema mode defaults to the base's.
	created := startKbBuilder(t, map[string]any{"mode": kb.BuilderModeConfig, "knowledge_base_id": slug})
	var instructions string
	dbfx.QueryRow(t, `SELECT instructions FROM agent WHERE id = $1`, created.BuilderAgentID).Scan(&instructions)
	if !strings.Contains(instructions, "`marvis kb get "+slug+"`") || !strings.Contains(instructions, "Schema mode at start: custom") {
		t.Errorf("config instructions do not name %s with its schema mode", slug)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_builder_session WHERE chat_session_id = $1 AND mode = 'config' AND knowledge_base_id = $2`, created.SessionID, base); n != 1 {
		t.Errorf("config builder row = %d, want 1", n)
	}
	insertChatMessage(t, created.SessionID, "user", "hi")
	if findKbBuilder(listKbBuilders(t, "mode=config&kb="+slug), created.SessionID) == nil {
		t.Errorf("config session missing from its knowledge base's list")
	}
}

func TestSaveKbBuilderDraftRejections(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	created := startKbBuilder(t, map[string]any{"mode": kb.BuilderModeCreate})
	save := func(sessionID string, body any, want int) {
		t.Helper()
		testutil.Call(t, testHandler.SaveKbBuilderDraft, kbBuilderRequest(http.MethodPut, sessionID, "/draft", body)).Want(want)
	}

	save(created.SessionID, map[string]any{}, http.StatusBadRequest)
	save(created.SessionID, map[string]any{"draft": strings.Repeat("x", maxKbBuilderDraftBytes)}, http.StatusRequestEntityTooLarge)

	// An agent builder conversation is not a knowledge base builder one.
	agentBuilder := newBuilderSession(t)
	save(agentBuilder.SessionID, map[string]any{"draft": map[string]any{"name": "x"}}, http.StatusNotFound)
	testutil.Call(t, testHandler.DeleteKbBuilderSession, withChatTestWorkspaceCtx(t, kbBuilderRequest(http.MethodDelete, agentBuilder.SessionID, "", nil))).
		Want(http.StatusNotFound)
}

func createKbBaseRequest(t *testing.T, body map[string]any, want int) KbBaseMutationResponse {
	t.Helper()
	var got KbBaseMutationResponse
	resp := testutil.Call(t, testHandler.CreateKbBase, newRequest(http.MethodPost, "/api/kb/bases", body)).Want(want)
	if want == http.StatusCreated {
		resp.JSON(&got)
		dbfx.Cleanup(t, `DELETE FROM kb_base WHERE id = $1`, got.ID)
		dbfx.Cleanup(t, `DELETE FROM kb_config_revision WHERE knowledge_base_id = $1`, got.ID)
	}

	return got
}

func TestCreateKbBase(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("pay-%d", time.Now().UnixNano())
	created := createKbBaseRequest(t, map[string]any{
		"name": " 支付排障手册 ", "slug": " " + strings.ToUpper(slug) + " ", "description": "支付与排障。",
		"purpose": "# Purpose", "schema_mode": kb.SchemaModeDefault,
	}, http.StatusCreated)
	if created.Name != "支付排障手册" || created.Slug != slug || created.SchemaMode != kb.SchemaModeDefault ||
		created.CreatedBy != testUserID || created.PageCount != 0 {
		t.Errorf("created = %+v", created.KbBaseResponse)
	}
	if created.Mention != "[支付排障手册](mention://kb/"+created.ID+")" {
		t.Errorf("mention = %q", created.Mention)
	}

	var schema, purpose string
	dbfx.QueryRow(t, `SELECT schema, purpose FROM kb_base WHERE id = $1`, created.ID).Scan(&schema, &purpose)
	if schema != kb.DefaultSchema || purpose != "# Purpose" {
		t.Errorf("stored schema is not the built-in template (purpose %q)", purpose)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_config_revision WHERE knowledge_base_id = $1 AND schema = $2 AND saved_by = $3`, created.ID, kb.DefaultSchema, testUserID); n != 1 {
		t.Errorf("config revisions = %d, want 1", n)
	}
	// Decision 103: no reserved quickstart page is created.
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_page WHERE knowledge_base_id = $1`, created.ID); n != 0 {
		t.Errorf("pages after create = %d, want 0", n)
	}

	custom := createKbBaseRequest(t, map[string]any{
		"name": "Custom", "slug": slug + "-c", "schema_mode": kb.SchemaModeCustom, "schema": "# My schema",
	}, http.StatusCreated)
	dbfx.QueryRow(t, `SELECT schema FROM kb_base WHERE id = $1`, custom.ID).Scan(&schema)
	if schema != "# My schema" {
		t.Errorf("custom schema = %q", schema)
	}

	for name, body := range map[string]map[string]any{
		"missing name":          {"slug": slug + "-x", "schema_mode": kb.SchemaModeDefault},
		"missing slug":          {"name": "x", "schema_mode": kb.SchemaModeDefault},
		"bad slug":              {"name": "x", "slug": "a_b", "schema_mode": kb.SchemaModeDefault},
		"reserved slug":         {"name": "x", "slug": "new", "schema_mode": kb.SchemaModeDefault},
		"missing mode":          {"name": "x", "slug": slug + "-x"},
		"default with schema":   {"name": "x", "slug": slug + "-x", "schema_mode": kb.SchemaModeDefault, "schema": "# S"},
		"custom without schema": {"name": "x", "slug": slug + "-x", "schema_mode": kb.SchemaModeCustom},
	} {
		t.Run(name, func(t *testing.T) {
			createKbBaseRequest(t, body, http.StatusBadRequest)
		})
	}

	createKbBaseRequest(t, map[string]any{"name": "Dup", "slug": slug, "schema_mode": kb.SchemaModeDefault}, http.StatusConflict)
}

func patchKbBase(t *testing.T, userID, ref string, body map[string]any, want int) KbBaseMutationResponse {
	t.Helper()
	var got KbBaseMutationResponse
	req := withURLParam(newRequestAs(userID, http.MethodPatch, "/api/kb/bases/"+ref, body), "kb", ref)
	resp := testutil.Call(t, testHandler.UpdateKbBase, req).Want(want)
	if want == http.StatusOK {
		resp.JSON(&got)
	}

	return got
}

func TestUpdateKbBase(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	plain := dbfx.User(t, "KB Config Plain", fmt.Sprintf("kb-config-plain-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, plain, "member")
	other := dbfx.User(t, "KB Config Other", fmt.Sprintf("kb-config-other-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, other, "member")

	slug := fmt.Sprintf("cfg-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Config KB", slug, testutil.Cols{
		"created_by": plain, "schema": "# Old template", "updated_at": time.Now().Add(-time.Hour),
	})
	dbfx.Cleanup(t, `DELETE FROM kb_config_revision WHERE knowledge_base_id = $1`, base)
	var opened time.Time
	dbfx.QueryRow(t, `SELECT updated_at FROM kb_base WHERE id = $1`, base).Scan(&opened)

	// Not the creator, not an admin.
	patchKbBase(t, other, slug, map[string]any{"name": "x"}, http.StatusForbidden)

	// The creator renames; the default schema written at creation is kept.
	updated := patchKbBase(t, plain, slug, map[string]any{
		"name": "Renamed", "purpose": "# New purpose", "base_updated_at": opened.Format(time.RFC3339),
	}, http.StatusOK)
	if updated.Name != "Renamed" || updated.Description != "Config KB description" || updated.Mention == "" {
		t.Errorf("updated = %+v", updated)
	}
	var schema, purpose string
	dbfx.QueryRow(t, `SELECT schema, purpose FROM kb_base WHERE id = $1`, base).Scan(&schema, &purpose)
	if schema != "# Old template" || purpose != "# New purpose" {
		t.Errorf("schema=%q purpose=%q", schema, purpose)
	}

	// The editor opened before that save: stale.
	patchKbBase(t, plain, slug, map[string]any{"name": "Again", "base_updated_at": opened.Format(time.RFC3339)}, http.StatusConflict)

	patchKbBase(t, plain, slug, map[string]any{"schema": "# S"}, http.StatusBadRequest)
	patchKbBase(t, plain, slug, map[string]any{"schema_mode": kb.SchemaModeCustom}, http.StatusBadRequest)
	patchKbBase(t, plain, slug, map[string]any{"name": " "}, http.StatusBadRequest)
	patchKbBase(t, plain, slug, map[string]any{"base_updated_at": "yesterday"}, http.StatusBadRequest)

	// An owner (the fixture user) switches to custom, then back to default,
	// which restores today's built-in template.
	patchKbBase(t, testUserID, base, map[string]any{"schema_mode": kb.SchemaModeCustom, "schema": "# Custom"}, http.StatusOK)
	dbfx.QueryRow(t, `SELECT schema FROM kb_base WHERE id = $1`, base).Scan(&schema)
	if schema != "# Custom" {
		t.Errorf("custom schema = %q", schema)
	}
	patchKbBase(t, testUserID, base, map[string]any{"schema_mode": kb.SchemaModeDefault}, http.StatusOK)
	dbfx.QueryRow(t, `SELECT schema FROM kb_base WHERE id = $1`, base).Scan(&schema)
	if schema != kb.DefaultSchema {
		t.Errorf("switching back to default must restore the built-in schema")
	}

	if n := dbfx.Count(t, `SELECT count(*) FROM kb_config_revision WHERE knowledge_base_id = $1`, base); n != 3 {
		t.Errorf("config revisions = %d, want one per save (3)", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_config_revision WHERE knowledge_base_id = $1 AND saved_by = $2 AND name = 'Renamed'`, base, plain); n != 1 {
		t.Errorf("first revision is not attributed to its saver")
	}
}

func TestGetKbTemplates(t *testing.T) {
	var got KbTemplatesResponse
	testutil.Call(t, (&Handler{}).GetKbTemplates, newRequest(http.MethodGet, "/api/kb/templates", nil)).
		Want(http.StatusOK).JSON(&got)
	if got.DefaultSchema != kb.DefaultSchema || got.PurposeTemplate != kb.PurposeTemplate {
		t.Errorf("templates = %+v", got)
	}
}
