package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/yunboom/marvis/server/internal/testutil"
)

func TestCreateKnowledgeSessionUsesHiddenCarrierAndRemembersMaintainer(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	agentID := knowledgeAgent(t, wsID, ownerID)
	kb := listKnowledgeBases(t, ownerID, wsID)[0]
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE workspace_id = $1`, wsID)
	dbfx.Cleanup(t, `DELETE FROM agent WHERE workspace_id = $1 AND kind = 'system'`, wsID)

	create := func(body map[string]any, want int) CreateKnowledgeSessionResponse {
		t.Helper()
		var out CreateKnowledgeSessionResponse
		resp := testutil.Call(t, testHandler.CreateKnowledgeSession, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/sessions", body)).Want(want)
		if want == http.StatusCreated {
			resp.JSON(&out)
		}
		return out
	}

	create(map[string]any{"kind": "fix", "knowledge_base_id": kb.ID}, http.StatusConflict)
	create(map[string]any{"kind": "nope", "knowledge_base_id": kb.ID}, http.StatusBadRequest)

	first := create(map[string]any{"kind": "fix", "knowledge_base_id": kb.ID, "agent_id": agentID}, http.StatusCreated)
	if first.MaintainerAgentID != agentID || first.CarrierAgentID == agentID {
		t.Fatalf("session = %+v", first)
	}
	if kind := queryString(t, `SELECT kind FROM agent WHERE id = $1`, first.CarrierAgentID); kind != "system" {
		t.Fatalf("carrier kind = %q, want system", kind)
	}
	if instr := queryString(t, `SELECT instructions FROM agent WHERE id = $1`, first.CarrierAgentID); !strings.Contains(instr, "Knowledge maintenance session") {
		t.Fatalf("carrier instructions miss the knowledge rules: %q", instr)
	}
	if got := queryString(t, `SELECT coalesce(maintainer_agent_id::text, '') FROM knowledge_base WHERE id = $1`, kb.ID); got != agentID {
		t.Fatalf("maintainer not remembered: %q", got)
	}
	if got := queryString(t, `SELECT kind FROM knowledge_session WHERE chat_session_id = $1`, first.SessionID); got != knowledgeSessionFix {
		t.Fatalf("knowledge_session kind = %q", got)
	}

	second := create(map[string]any{"kind": "fresh", "knowledge_base_id": kb.ID}, http.StatusCreated)
	if second.MaintainerAgentID != agentID {
		t.Fatalf("second session did not reuse the maintainer: %+v", second)
	}

	machine := kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/sessions", map[string]any{"kind": "fresh", "knowledge_base_id": kb.ID})
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.CreateKnowledgeSession, machine).Want(http.StatusForbidden)

	var meta KnowledgeSessionResponse
	testutil.Call(t, testHandler.GetKnowledgeSession, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/sessions/"+first.SessionID, nil, "sessionId", first.SessionID)).
		Want(http.StatusOK).JSON(&meta)
	if meta.Kind != knowledgeSessionFix || meta.CreatedBy != ownerID {
		t.Fatalf("session meta = %+v", meta)
	}
}
