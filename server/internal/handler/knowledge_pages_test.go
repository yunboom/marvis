package handler

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/yunboom/marvis/server/internal/knowledge"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// seedKnowledgePages 在工作区主线上写入页面，返回新的主线提交。
func seedKnowledgePages(t *testing.T, wsID, userID string, files map[string]string) {
	t.Helper()
	listKnowledgeBases(t, userID, wsID) // 确保仓库与内置库已生成
	changes := make([]knowledge.FileChange, 0, len(files))
	for p, c := range files {
		changes = append(changes, knowledge.FileChange{Path: p, Content: []byte(c)})
	}
	if _, err := testHandler.commitKnowledgeMain(context.Background(), wsID, "seed", knowledge.Signature{Name: "test"}, func(string) ([]knowledge.FileChange, error) {
		return changes, nil
	}); err != nil {
		t.Fatalf("seed pages: %v", err)
	}
}

func knowledgeAgent(t *testing.T, wsID, ownerID string) string {
	t.Helper()
	runtimeID := dbfx.Runtime(t, "kb-runtime", testutil.Cols{"workspace_id": wsID, "owner_id": ownerID})

	return dbfx.Agent(t, "Marvis", runtimeID, testutil.Cols{"workspace_id": wsID, "owner_id": ownerID})
}

func TestKnowledgePagesTreeAndDetail(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	viewerID := knowledgeMember(t, wsID, "member")
	agentID := knowledgeAgent(t, wsID, ownerID)
	sessionID := dbfx.ChatSession(t, agentID, testutil.Cols{"workspace_id": wsID, "creator_id": ownerID})

	seedKnowledgePages(t, wsID, ownerID, map[string]string{
		"team/wiki/entities/payment-service.md": "---\ntype: entity\ntitle: 支付服务\ndomains: [dev]\nverified: {by: 王芳, at: 2026-10-20}\n---\n\n## 职责\n\n支付服务负责创建支付单。[^1] 回调按交易号去重。[^2]\n\n[^1]: task://MAR-128 支付回调重构\n[^2]: chat://" + sessionID + " 私聊里的结论\n",
		"team/wiki/entities/order-service.md":   "---\ntitle: 订单服务\n---\n订单服务管理下单，见 [支付服务](payment-service.md)。\n",
	})

	annKB := listKnowledgeBases(t, ownerID, wsID)[0]
	dbfx.Insert(t, "knowledge_annotation", testutil.Cols{
		"workspace_id": wsID, "knowledge_base_id": annKB.ID, "page_path": "team/wiki/entities/payment-service.md",
		"body": "可能过期", "author_type": "agent", "author_id": agentID,
	})

	var tree KnowledgePageListResponse
	testutil.Call(t, testHandler.ListKnowledgePages, kbRequest(viewerID, wsID, http.MethodGet, "/api/knowledge/bases/team/pages", nil, "id", "team")).
		Want(http.StatusOK).JSON(&tree)
	if len(tree.Pages) != 2 {
		t.Fatalf("tree pages = %+v", tree.Pages)
	}
	var payment KnowledgePageSummary
	for _, p := range tree.Pages {
		if p.Path == "team/wiki/entities/payment-service.md" {
			payment = p
		}
	}
	if payment.Title != "支付服务" || payment.Group != "entities" || !payment.Verified || payment.OpenAnnotations != 1 || payment.AgentFindings != 1 {
		t.Fatalf("payment summary = %+v", payment)
	}

	path := "/api/knowledge/bases/team/page?path=" + url.QueryEscape("team/wiki/entities/payment-service.md")
	var asViewer KnowledgePageResponse
	testutil.Call(t, testHandler.GetKnowledgePage, kbRequest(viewerID, wsID, http.MethodGet, path, nil, "id", "team")).Want(http.StatusOK).JSON(&asViewer)
	if len(asViewer.Sections) != 1 || len(asViewer.Sections[0].Paragraphs[0]) != 2 {
		t.Fatalf("sections = %+v", asViewer.Sections)
	}
	if len(asViewer.Backlinks) != 1 || asViewer.Backlinks[0].Title != "订单服务" {
		t.Fatalf("backlinks = %+v", asViewer.Backlinks)
	}
	chat := asViewer.Sources[1]
	if chat.Kind != knowledge.SourceChat || chat.URI != "" || chat.Label != "" || chat.Chat == nil || chat.Chat.Openable || chat.Chat.SessionID != "" || chat.Chat.AgentName != "Marvis" {
		t.Fatalf("chat source for a non-owner leaks the session: %+v %+v", chat, chat.Chat)
	}

	var asOwner KnowledgePageResponse
	testutil.Call(t, testHandler.GetKnowledgePage, kbRequest(ownerID, wsID, http.MethodGet, path, nil, "id", "team")).Want(http.StatusOK).JSON(&asOwner)
	if c := asOwner.Sources[1].Chat; c == nil || !c.Openable || c.SessionID != sessionID {
		t.Fatalf("owner cannot open own chat source: %+v", c)
	}

	testutil.Call(t, testHandler.GetKnowledgePage, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/bases/team/page?path=other/wiki/x.md", nil, "id", "team")).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.GetKnowledgePage, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/bases/team/page?path=team/wiki/x.md", nil, "id", "team")).Want(http.StatusNotFound)

	var graph KnowledgeGraphResponse
	testutil.Call(t, testHandler.GetKnowledgeGraph, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/bases/team/graph", nil, "id", "team")).Want(http.StatusOK).JSON(&graph)
	if len(graph.Nodes) != 2 || len(graph.Edges) != 1 {
		t.Fatalf("graph = %+v", graph)
	}
}

func TestSearchKnowledgeRecordsMissesOnce(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{
		"team/wiki/concepts/refund-rules.md": "---\ntitle: 退款规则\n---\n原路退款在次日批量提交渠道。\n",
	})

	var hit KnowledgeSearchResponse
	testutil.Call(t, testHandler.SearchKnowledge, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/search?q="+url.QueryEscape("退款"), nil)).Want(http.StatusOK).JSON(&hit)
	if len(hit.Hits) != 1 || hit.Hits[0].Title != "退款规则" || hit.Gap != nil {
		t.Fatalf("hit = %+v", hit)
	}

	missURL := "/api/knowledge/search?record_miss=1&q=" + url.QueryEscape("渠道限流阈值")
	var miss, again KnowledgeSearchResponse
	testutil.Call(t, testHandler.SearchKnowledge, kbRequest(ownerID, wsID, http.MethodGet, missURL, nil)).Want(http.StatusOK).JSON(&miss)
	testutil.Call(t, testHandler.SearchKnowledge, kbRequest(ownerID, wsID, http.MethodGet, missURL, nil)).Want(http.StatusOK).JSON(&again)
	if miss.Gap == nil || again.Gap == nil || miss.Gap.ID != again.Gap.ID || miss.Gap.Source != knowledgeGapSearchMiss {
		t.Fatalf("miss gaps = %+v / %+v", miss.Gap, again.Gap)
	}

	var gaps []KnowledgeGapResponse
	testutil.Call(t, testHandler.ListKnowledgeGaps, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/gaps?status=open", nil)).Want(http.StatusOK).JSON(&gaps)
	if len(gaps) != 1 {
		t.Fatalf("gaps = %+v", gaps)
	}

	var filled KnowledgeGapResponse
	testutil.Call(t, testHandler.UpdateKnowledgeGap, kbRequest(ownerID, wsID, http.MethodPatch, "/api/knowledge/gaps/"+gaps[0].ID,
		map[string]any{"status": "filled"}, "gapId", gaps[0].ID)).Want(http.StatusOK).JSON(&filled)
	if filled.Status != knowledgeGapFilled {
		t.Fatalf("filled = %+v", filled)
	}
	testutil.Call(t, testHandler.UpdateKnowledgeGap, kbRequest(ownerID, wsID, http.MethodPatch, "/api/knowledge/gaps/"+gaps[0].ID,
		map[string]any{"status": "done"}, "gapId", gaps[0].ID)).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.SearchKnowledge, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/search?q=", nil)).Want(http.StatusBadRequest)

	var created KnowledgeGapResponse
	testutil.Call(t, testHandler.CreateKnowledgeGap, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/gaps",
		map[string]any{"question": "退款失败多久人工介入？"})).Want(http.StatusCreated).JSON(&created)
	if created.Source != knowledgeGapSearchMiss {
		t.Fatalf("member gap source = %q", created.Source)
	}
}
