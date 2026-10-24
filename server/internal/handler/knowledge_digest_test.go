package handler

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/knowledge"
	"github.com/yunboom/marvis/server/internal/testutil"
)

func getDigest(t *testing.T, userID, wsID string) KnowledgeDigestResponse {
	t.Helper()
	var out KnowledgeDigestResponse
	testutil.Call(t, testHandler.GetKnowledgeDigest, kbRequest(userID, wsID, http.MethodGet, "/api/knowledge/digest", nil)).Want(http.StatusOK).JSON(&out)

	return out
}

func patchDigest(t *testing.T, userID, wsID, autopilotID string, body map[string]any, want int) {
	t.Helper()
	testutil.Call(t, testHandler.UpdateAutopilot, kbRequest(userID, wsID, http.MethodPatch, "/api/autopilots/"+autopilotID, body, "id", autopilotID)).Want(want)
}

func TestKnowledgeDigestLifecycleAndGuards(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")
	agentID := knowledgeAgent(t, wsID, ownerID)
	dbfx.Cleanup(t, `DELETE FROM autopilot WHERE workspace_id = $1`, wsID)

	if got := getDigest(t, memberID, wsID); got.Autopilot != nil || got.KnowledgeBaseCount != 0 {
		t.Fatalf("digest before create = %+v", got)
	}

	body := map[string]any{"assignee_id": agentID, "cron_expression": "0 21 * * *", "timezone": "Asia/Shanghai"}
	testutil.Call(t, testHandler.CreateKnowledgeDigest, kbRequest(memberID, wsID, http.MethodPost, "/api/knowledge/digest", body)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.CreateKnowledgeDigest, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/digest",
		map[string]any{"assignee_id": agentID, "cron_expression": "not cron"})).Want(http.StatusBadRequest)

	var created KnowledgeDigestResponse
	testutil.Call(t, testHandler.CreateKnowledgeDigest, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/digest", body)).Want(http.StatusCreated).JSON(&created)
	ap := created.Autopilot
	if ap == nil || ap.Status != autopilotStatusPaused || ap.ExecutionMode != autopilotModeRunOnly || ap.SystemKey == nil || *ap.SystemKey != autopilotSystemKeyKnowledgeDigest {
		t.Fatalf("created digest = %+v", ap)
	}
	if created.Schedule == nil || created.Schedule.CronExpression == nil || *created.Schedule.CronExpression != "0 21 * * *" {
		t.Fatalf("schedule = %+v", created.Schedule)
	}
	testutil.Call(t, testHandler.CreateKnowledgeDigest, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/digest", body)).Want(http.StatusConflict)

	// 没有知识库时不能启用；有了知识库才可以。
	patchDigest(t, ownerID, wsID, ap.ID, map[string]any{"status": autopilotStatusActive}, http.StatusConflict)
	bases := listKnowledgeBases(t, ownerID, wsID)
	patchDigest(t, ownerID, wsID, ap.ID, map[string]any{"status": autopilotStatusActive}, http.StatusOK)

	// 不能删除、不能归档、不能改执行方式；可以编辑描述。
	testutil.Call(t, testHandler.DeleteAutopilot, kbRequest(ownerID, wsID, http.MethodDelete, "/api/autopilots/"+ap.ID, nil, "id", ap.ID)).Want(http.StatusConflict)
	patchDigest(t, ownerID, wsID, ap.ID, map[string]any{"status": autopilotStatusArchived}, http.StatusConflict)
	patchDigest(t, ownerID, wsID, ap.ID, map[string]any{"execution_mode": "create_issue"}, http.StatusConflict)
	patchDigest(t, ownerID, wsID, ap.ID, map[string]any{"description": "custom instructions"}, http.StatusOK)

	// 只有 owner / admin 能改内置自动化；定时触发器只能改不能删。
	patchDigest(t, memberID, wsID, ap.ID, map[string]any{"description": "member edit"}, http.StatusForbidden)
	testutil.Call(t, testHandler.DeleteAutopilotTrigger, kbRequest(ownerID, wsID, http.MethodDelete,
		"/api/autopilots/"+ap.ID+"/triggers/"+created.Schedule.ID, nil, "id", ap.ID, "triggerId", created.Schedule.ID)).Want(http.StatusConflict)

	// 删光知识库后自动停用并记录原因。
	for _, kb := range bases {
		testutil.Call(t, testHandler.DeleteKnowledgeBase, kbRequest(ownerID, wsID, http.MethodDelete, "/api/knowledge/bases/"+kb.ID, nil, "id", kb.ID)).Want(http.StatusNoContent)
	}
	after := getDigest(t, ownerID, wsID)
	if after.Autopilot.Status != autopilotStatusPaused || after.Autopilot.PauseReason == nil || *after.Autopilot.PauseReason != pauseReasonNoKnowledgeBase {
		t.Fatalf("digest after deleting all knowledge bases = %+v", after.Autopilot)
	}
}

func TestListKnowledgeSourcesReadsOnlyCallersOwnChats(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	otherID := knowledgeMember(t, wsID, "member")
	agentID := knowledgeAgent(t, wsID, ownerID)
	runtimeID := dbfx.Runtime(t, "kb-sys-runtime", testutil.Cols{"workspace_id": wsID, "owner_id": ownerID})
	systemAgentID := dbfx.Agent(t, ".marvis-knowledge-x", runtimeID, testutil.Cols{"workspace_id": wsID, "owner_id": ownerID, "kind": "system"})

	since := time.Now().Add(-time.Minute).UTC()
	issueID := dbfx.Issue(t, "退款改为原路返回", testutil.Cols{"workspace_id": wsID, "creator_id": ownerID, "description": "退款走原支付渠道"})
	dbfx.Comment(t, issueID, "已确认渠道支持", testutil.Cols{"workspace_id": wsID, "author_id": otherID})
	own := dbfx.ChatSession(t, agentID, testutil.Cols{"workspace_id": wsID, "creator_id": ownerID, "title": "退款讨论"})
	others := dbfx.ChatSession(t, agentID, testutil.Cols{"workspace_id": wsID, "creator_id": otherID})
	hidden := dbfx.ChatSession(t, systemAgentID, testutil.Cols{"workspace_id": wsID, "creator_id": ownerID})
	for _, s := range []string{own, others, hidden} {
		dbfx.Insert(t, "chat_message", testutil.Cols{"chat_session_id": s, "role": "user", "content": "message in " + s})
	}

	q := url.Values{"since": {since.Format(time.RFC3339Nano)}}
	var got KnowledgeSourcesResponse
	testutil.Call(t, testHandler.ListKnowledgeSources, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/sources?"+q.Encode(), nil)).Want(http.StatusOK).JSON(&got)

	kinds := map[string]int{}
	for _, it := range got.Items {
		kinds[it.Kind]++
		if it.Kind == knowledge.SourceItemChat && it.URI != "chat://"+own {
			t.Fatalf("leaked chat %s", it.URI)
		}
	}
	if kinds[knowledge.SourceItemTask] != 1 || kinds[knowledge.SourceItemComment] != 1 || kinds[knowledge.SourceItemChat] != 1 {
		t.Fatalf("items = %+v", got.Items)
	}
	if got.Page != 1 || got.Pages != 1 || got.Truncated || got.Until == "" {
		t.Fatalf("paging = %+v", got)
	}

	// 翻到不存在的页返回空列表；参数错误返回 400。
	q.Set("page", "2")
	q.Set("until", got.Until)
	var empty KnowledgeSourcesResponse
	testutil.Call(t, testHandler.ListKnowledgeSources, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/sources?"+q.Encode(), nil)).Want(http.StatusOK).JSON(&empty)
	if len(empty.Items) != 0 {
		t.Fatalf("page 2 = %+v", empty.Items)
	}
	for _, bad := range []string{"page=0", "context_window=100", "since=yesterday", "since=2030-01-01T00:00:00Z"} {
		testutil.Call(t, testHandler.ListKnowledgeSources, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/sources?"+bad, nil)).Want(http.StatusBadRequest)
	}
}
