package handler

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/knowledge"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const (
	// knowledgeSourcesDefaultWindow 是没传 context_window 时假定的上下文窗口（token）。
	knowledgeSourcesDefaultWindow = 200000
	// knowledgeSourcesMinWindow 防止过小的窗口把资料切成上千页。
	knowledgeSourcesMinWindow = 8000
	// knowledgeSourcesMaxRows 是每类资料最多读取的行数；超出时同样标记截断。
	knowledgeSourcesMaxRows = 5000
	// knowledgeSourcesDefaultLookback 是没有上次运行记录时回看的时长。
	knowledgeSourcesDefaultLookback = 24 * time.Hour
)

// KnowledgeSourcesResponse 是一页沉淀资料。since / until 在第一页确定后由调用方原样带回，保证翻页时资料集合不变。
type KnowledgeSourcesResponse struct {
	Since     string `json:"since"`
	Until     string `json:"until"`
	Page      int    `json:"page"`
	Pages     int    `json:"pages"`
	Truncated bool   `json:"truncated"`
	// Remaining 是超出 10 页被丢弃的条数；某类资料达到行数上限时超出部分无法计数，不计入。
	Remaining int                    `json:"remaining"`
	Items     []knowledge.SourceItem `json:"items"`
}

// ListKnowledgeSources 返回 [since, until) 内的任务、评论和调用者本人的对话（GET /api/knowledge/sources）。
// 参数：since、until（RFC3339，缺省为上次每日知识沉淀运行时间与现在）、page（从 1 开始）、context_window（token）。
// 对话只取调用者自己创建、对象是普通智能体的会话；智能体用任务 token 调用时，调用者就是运行时主人。
func (h *Handler) ListKnowledgeSources(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	q := r.URL.Query()
	until := time.Now().UTC()
	if v := q.Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "until must be an RFC3339 time")
			return
		}
		until = t
	}
	var since time.Time
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "since must be an RFC3339 time")
			return
		}
		since = t
	} else {
		t, err := h.lastKnowledgeDigestRun(r.Context(), workspaceID)
		if err != nil {
			writeKnowledgeError(w, r, err, "failed to read digest runs")
			return
		}
		since = t
		if since.IsZero() {
			since = until.Add(-knowledgeSourcesDefaultLookback)
		}
	}
	if !since.Before(until) {
		writeError(w, http.StatusBadRequest, "since must be before until")
		return
	}
	page := 1
	if v := q.Get("page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "page must be a positive integer")
			return
		}
		page = n
	}
	window := knowledgeSourcesDefaultWindow
	if v := q.Get("context_window"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < knowledgeSourcesMinWindow {
			writeError(w, http.StatusBadRequest, "context_window must be an integer of at least 8000")
			return
		}
		window = n
	}

	items, capped, err := h.knowledgeSourceItems(r.Context(), workspaceID, userID, since, until)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to list sources")
		return
	}
	pages, remaining := knowledge.PaginateSources(items, window)

	resp := KnowledgeSourcesResponse{
		Since: since.Format(time.RFC3339Nano), Until: until.Format(time.RFC3339Nano),
		Page: page, Pages: len(pages), Truncated: remaining > 0 || capped, Remaining: remaining, Items: []knowledge.SourceItem{},
	}
	if page <= len(pages) {
		resp.Items = pages[page-1]
	}
	writeJSON(w, http.StatusOK, resp)
}

// knowledgeSourceItems 读取三类资料并按时间合并；capped 表示某类资料达到行数上限。
func (h *Handler) knowledgeSourceItems(ctx context.Context, workspaceID, userID string, since, until time.Time) ([]knowledge.SourceItem, bool, error) {
	ws := parseUUID(workspaceID)
	from := pgtype.Timestamptz{Time: since, Valid: true}
	to := pgtype.Timestamptz{Time: until, Valid: true}

	issues, err := h.Queries.ListKnowledgeSourceIssues(ctx, db.ListKnowledgeSourceIssuesParams{
		WorkspaceID: ws, Since: from, Until: to, MaxRows: knowledgeSourcesMaxRows,
	})
	if err != nil {
		return nil, false, errors.Wrapf(err, "list source issues workspace_id=%s", workspaceID)
	}
	comments, err := h.Queries.ListKnowledgeSourceComments(ctx, db.ListKnowledgeSourceCommentsParams{
		WorkspaceID: ws, Since: from, Until: to, MaxRows: knowledgeSourcesMaxRows,
	})
	if err != nil {
		return nil, false, errors.Wrapf(err, "list source comments workspace_id=%s", workspaceID)
	}
	chats, err := h.Queries.ListKnowledgeSourceChatMessages(ctx, db.ListKnowledgeSourceChatMessagesParams{
		WorkspaceID: ws, UserID: parseUUID(userID), Since: from, Until: to, MaxRows: knowledgeSourcesMaxRows,
	})
	if err != nil {
		return nil, false, errors.Wrapf(err, "list source chats workspace_id=%s", workspaceID)
	}

	type timed struct {
		at   time.Time
		item knowledge.SourceItem
	}
	all := make([]timed, 0, len(issues)+len(comments)+len(chats))
	for _, is := range issues {
		key := service.IssueIdentifier(is.IssuePrefix, is.Number)
		all = append(all, timed{is.UpdatedAt.Time, knowledge.SourceItem{
			Kind: knowledge.SourceItemTask, URI: "task://" + key, Title: is.Title, Status: is.Status,
			At: timestampToString(is.UpdatedAt), Text: knowledge.TrimSourceText(is.Description),
		}})
	}
	for _, c := range comments {
		key := service.IssueIdentifier(c.IssuePrefix, c.Number)
		all = append(all, timed{c.CreatedAt.Time, knowledge.SourceItem{
			Kind: knowledge.SourceItemComment, URI: "task://" + key, Author: c.AuthorName,
			At: timestampToString(c.CreatedAt), Text: knowledge.TrimSourceText(c.Content),
		}})
	}
	for _, m := range chats {
		all = append(all, timed{m.CreatedAt.Time, knowledge.SourceItem{
			Kind: knowledge.SourceItemChat, URI: "chat://" + uuidToString(m.ChatSessionID), Title: m.SessionTitle,
			Author: chatSourceAuthor(m), At: timestampToString(m.CreatedAt), Text: knowledge.TrimSourceText(m.Content),
		}})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })

	items := make([]knowledge.SourceItem, len(all))
	for i, t := range all {
		items[i] = t.item
	}
	capped := len(issues) == knowledgeSourcesMaxRows || len(comments) == knowledgeSourcesMaxRows || len(chats) == knowledgeSourcesMaxRows

	return items, capped, nil
}

// chatRoleAssistant 是 chat_message.role 里智能体回复的取值。
const chatRoleAssistant = "assistant"

func chatSourceAuthor(m db.ListKnowledgeSourceChatMessagesRow) string {
	if m.Role == chatRoleAssistant {
		return m.AgentName
	}

	return ""
}
