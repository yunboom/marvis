package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbQuoteRunes caps the quoted line a comment stores when the client only
// names the block.
const kbQuoteRunes = 200

// kbChatRoleUser is the role of a member's chat message.
const kbChatRoleUser = "user"

// KbMrCommentQuote is the diff line a review comment quotes.
type KbMrCommentQuote struct {
	PageID  string `json:"page_id"`
	BlockID string `json:"block_id"`
	Text    string `json:"text"`
}

// KbMrCommentTriggerResponse is one agent a comment started.
type KbMrCommentTriggerResponse struct {
	AgentID   string `json:"agent_id"`
	AgentName string `json:"agent_name"`
	Reason    string `json:"reason"`
	// ChatSessionID is the chat the agent works on the comment in ("查看执行过程").
	ChatSessionID *string `json:"chat_session_id"`
	TaskID        *string `json:"task_id"`
	// Running is set while that task is queued or running.
	Running bool `json:"running"`
}

// KbMrCommentResponse is one review comment.
type KbMrCommentResponse struct {
	ID             string                       `json:"id"`
	MergeRequestID string                       `json:"merge_request_id"`
	ParentID       *string                      `json:"parent_id"`
	Quote          *KbMrCommentQuote            `json:"quote"`
	Body           string                       `json:"body"`
	AuthorType     string                       `json:"author_type"`
	AuthorID       string                       `json:"author_id"`
	AuthorName     string                       `json:"author_name"`
	Triggered      []KbMrCommentTriggerResponse `json:"triggered"`
	CreatedAt      string                       `json:"created_at"`
}

// CreateKbMrCommentRequest posts a review comment. The quote comes either as
// spec's quote object or, from kb mr comment add, as a page reference and a
// block id; the quoted text is then read from the block.
type CreateKbMrCommentRequest struct {
	ParentID     *string           `json:"parent_id"`
	Quote        *KbMrCommentQuote `json:"quote"`
	QuotePage    string            `json:"quote_page"`
	QuoteBlockID string            `json:"quote_block_id"`
	Body         string            `json:"body"`
}

// kbCommentTrigger is one kb_mr_comment.triggered entry.
type kbCommentTrigger struct {
	AgentID       string `json:"agent_id"`
	Reason        string `json:"reason"`
	TaskID        string `json:"task_id,omitempty"`
	ChatSessionID string `json:"chat_session_id,omitempty"`
}

func parseKbCommentTriggers(raw []byte) ([]kbCommentTrigger, error) {
	out := []kbCommentTrigger{}
	if len(raw) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, errors.Wrap(err, "decode comment triggers")
	}

	return out, nil
}

// ListKbMrComments lists a merge request's review comments, oldest first
// (GET /api/kb/merge-requests/{number}/comments).
func (h *Handler) ListKbMrComments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mr, _, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}

	rows, err := h.Queries.ListKbMrComments(ctx, mr.ID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list comments merge_request_id=%s", uuidToString(mr.ID)))
		return
	}
	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, rows)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// CreateKbMrComment posts a review comment and starts agents on it like an
// issue comment would (spec 7.9, 8.6): the agents it @-mentions, else the
// author agent. A request from a job hands the comment to the job's chat,
// so the agent keeps working on the job's draft; otherwise the agent gets a
// chat turn with the comment as its instructions. No job is created.
func (h *Handler) CreateKbMrComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbMrCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "body is required")
		return
	}

	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	workspaceID := uuidToString(base.WorkspaceID)
	actorType, actorID := h.resolveActor(r, userID, workspaceID)

	existing, err := h.Queries.ListKbMrComments(ctx, mr.ID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list comments merge_request_id=%s", uuidToString(mr.ID)))
		return
	}
	parentID, err := kbCommentParent(existing, req.ParentID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	quote, quotePage, err := h.kbCommentQuote(ctx, base, mr, req)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	params := db.CreateKbMrCommentParams{
		MergeRequestID: mr.ID,
		ParentID:       parentID,
		Body:           body,
		AuthorType:     actorType,
		AuthorID:       parseUUID(actorID),
	}
	if quote != nil {
		params.QuotePageID = parseUUID(quote.PageID)
		params.QuoteBlockID = quote.BlockID
		params.QuoteText = quote.Text
	}
	comment, err := h.Queries.CreateKbMrComment(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create comment merge_request_id=%s", uuidToString(mr.ID)))
		return
	}

	triggers, err := h.dispatchKbMrComment(ctx, r, kbReviewDispatch{
		base: base, mr: mr, comment: comment, earlier: existing, quote: quote, quotePage: quotePage,
		actorType: actorType, actorID: actorID, userID: userID,
	})
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if len(triggers) > 0 {
		raw, err := json.Marshal(triggers)
		if err != nil {
			h.writeKbInternalError(w, r, errors.WithStack(err))
			return
		}
		if comment, err = h.Queries.SetKbMrCommentTriggered(ctx, db.SetKbMrCommentTriggeredParams{ID: comment.ID, Triggered: raw}); err != nil {
			h.writeKbInternalError(w, r, errors.Wrapf(err, "record triggers comment_id=%s", uuidToString(comment.ID)))
			return
		}
	}

	h.publish(protocol.EventKbMrCommented, workspaceID, actorType, actorID, map[string]any{
		"merge_request_id":  uuidToString(mr.ID),
		"number":            mr.Number,
		"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
		"comment_id":        uuidToString(comment.ID),
	})

	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, []db.KbMrComment{comment})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp[0])
}

// kbCommentParent checks a reply's parent and keeps threads one level deep:
// a reply to a reply goes under the thread's first comment.
func kbCommentParent(existing []db.KbMrComment, raw *string) (pgtype.UUID, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return pgtype.UUID{}, nil
	}

	for _, c := range existing {
		if uuidToString(c.ID) != strings.TrimSpace(*raw) {
			continue
		}
		if c.ParentID.Valid {
			return c.ParentID, nil
		}

		return c.ID, nil
	}

	return pgtype.UUID{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "parent_id is not a comment of this merge request")
}

// kbCommentQuote resolves the quoted line and the title of its page. A page
// reference resolves through the request's draft; a missing text is the
// block's first line.
func (h *Handler) kbCommentQuote(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, req CreateKbMrCommentRequest) (*KbMrCommentQuote, string, error) {
	quote := req.Quote
	if quote == nil && req.QuotePage != "" {
		quote = &KbMrCommentQuote{BlockID: req.QuoteBlockID}
	}
	if quote == nil {
		return nil, "", nil
	}
	if quote.BlockID == "" {
		return nil, "", kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a quote needs block_id")
	}

	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, mr.DraftID)
	if err != nil {
		return nil, "", err
	}
	pageRef := quote.PageID
	if pageRef == "" {
		pageRef = req.QuotePage
	}
	pageID, root, err := overlay.resolveRef(base, pageRef)
	if err == nil && root {
		err = kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a quote needs a page")
	}
	if err != nil {
		// A page the draft deletes is no longer in the overlay but can still
		// be quoted from the diff.
		if _, deleted := overlay.rows[pageRef]; !deleted {
			return nil, "", err
		}
		pageID = pageRef
	}
	quote.PageID = pageID

	if strings.TrimSpace(quote.Text) == "" {
		text, err := h.kbQuotedBlockText(ctx, base, overlay, pageID, quote.BlockID)
		if err != nil {
			return nil, "", err
		}
		quote.Text = text
	}

	title := pageID
	if node, ok := overlay.tree.Node(pageID); ok && node.Title != "" {
		title = node.Title
	} else if row, ok := overlay.rows[pageID]; ok {
		if t, _ := row.header[kb.MetaTitle].(string); t != "" {
			title = t
		}
	}

	return quote, title, nil
}

func (h *Handler) kbQuotedBlockText(ctx context.Context, base db.KbBase, overlay kbOverlay, pageID, blockID string) (string, error) {
	row, inDraft := overlay.rows[pageID]
	blocks := row.blocks
	if !inDraft {
		page, err := h.Queries.GetKbPage(ctx, db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: parseUUID(pageID)})
		if err != nil {
			if isNotFound(err) {
				return "", kbFail(http.StatusBadRequest, kbCodePageNotFound, "the quoted page is not found")
			}

			return "", errors.Wrapf(err, "load quoted page page_id=%s", pageID)
		}
		if blocks, err = kb.ParseBlocks(page.Blocks); err != nil {
			return "", errors.Wrapf(err, "page_id=%s", pageID)
		}
	}

	for _, b := range blocks {
		if b.ID == blockID {
			line, _, _ := strings.Cut(b.Content, "\n")

			return kbSnippet(line, kbQuoteRunes), nil
		}
	}

	return "", kbFail(http.StatusBadRequest, kbCodeBlockNotFound, "the quoted block is not on the page")
}

// kbReviewDispatch is a posted comment about to be handed to agents.
type kbReviewDispatch struct {
	base      db.KbBase
	mr        db.KbMergeRequest
	comment   db.KbMrComment
	earlier   []db.KbMrComment
	quote     *KbMrCommentQuote
	quotePage string
	actorType string
	actorID   string
	userID    string
}

// dispatchKbMrComment starts the agents a comment triggers and returns what
// it started. Agents that are gone, archived, without a runtime or that the
// commenter may not run are skipped.
func (h *Handler) dispatchKbMrComment(ctx context.Context, r *http.Request, d kbReviewDispatch) ([]kbCommentTrigger, error) {
	mr := d.mr
	workspaceID := uuidToString(d.base.WorkspaceID)
	origins, err := h.Queries.ListKbMergeRequestOrigins(ctx, db.ListKbMergeRequestOriginsParams{WorkspaceID: mr.WorkspaceID, DraftIds: []pgtype.UUID{mr.DraftID}})
	if err != nil {
		return nil, errors.Wrapf(err, "load merge request origin merge_request_id=%s", uuidToString(mr.ID))
	}
	var origin db.ListKbMergeRequestOriginsRow
	if len(origins) > 0 {
		origin = origins[0]
	}

	authorAgent := ""
	if id := kbReviewAgentID(mr, origin); id.Valid {
		authorAgent = uuidToString(id)
	}
	planned := kb.ReviewCommentTriggers(kb.ReviewTriggerInput{
		Body:          d.comment.Body,
		CommenterType: d.actorType,
		CommenterID:   d.actorID,
		AuthorAgentID: authorAgent,
	})
	if len(planned) == 0 {
		return nil, nil
	}

	agentIDs := make([]pgtype.UUID, len(planned))
	for i, t := range planned {
		agentIDs[i] = parseUUID(t.AgentID)
	}
	agentRows, err := h.Queries.ListKbAgentsByIDs(ctx, db.ListKbAgentsByIDsParams{WorkspaceID: d.base.WorkspaceID, Ids: agentIDs})
	if err != nil {
		return nil, errors.Wrapf(err, "load triggered agents comment_id=%s", uuidToString(d.comment.ID))
	}
	agents := make(map[string]db.Agent, len(agentRows))
	for _, a := range agentRows {
		agents[uuidToString(a.ID)] = a
	}
	chats, err := h.kbReviewChats(ctx, d, origin)
	if err != nil {
		return nil, err
	}

	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, []kbActor{{kind: d.actorType, id: parseUUID(d.actorID)}})
	if err != nil {
		return nil, err
	}
	in := kb.ReviewCommentInput{
		Number:    int(mr.Number),
		Title:     mr.Title,
		Author:    names.name(d.actorType, parseUUID(d.actorID)),
		Body:      d.comment.Body,
		DraftID:   uuidToString(mr.DraftID),
		CommentID: uuidToString(d.comment.ID),
	}
	if d.quote != nil {
		in.QuoteText = d.quote.Text
		in.QuotePage = d.quotePage
	}
	message, err := kb.ReviewCommentMessage(in)
	if err != nil {
		return nil, err
	}

	originator := h.invokeOriginatorFromRequest(r, d.actorType, d.actorID)
	out := make([]kbCommentTrigger, 0, len(planned))
	// One chat turn per agent: each send is its own transaction on that
	// agent's chat and the invoke check reads the agent's access rules, so the
	// (usually single) trigger cannot be batched.
	for _, t := range planned {
		agent, ok := agents[t.AgentID]
		if !ok || agent.Kind == kbAgentKindSystem || agent.ArchivedAt.Valid || !agent.RuntimeID.Valid {
			continue
		}
		if !h.canInvokeAgent(ctx, agent, d.actorType, d.actorID, originator, workspaceID) {
			continue
		}

		session, ok := chats[t.AgentID]
		if !ok {
			if session, err = h.createKbReviewChat(ctx, d.base, mr, agent, d.userID); err != nil {
				return nil, err
			}
		}
		sent, err := h.TaskService.SendDirectChatMessage(ctx, session, agent, parseUUID(d.userID), message, nil, d.actorType, parseUUID(d.actorID))
		if err != nil {
			if errors.Is(err, service.ErrChatTaskAgentNoRuntime) || errors.Is(err, service.ErrChatTaskAgentArchived) || errors.Is(err, service.ErrChatSessionArchived) {
				continue
			}

			return nil, errors.Wrapf(err, "hand comment to agent comment_id=%s agent_id=%s", uuidToString(d.comment.ID), t.AgentID)
		}

		sessionID := uuidToString(session.ID)
		h.publishChat(protocol.EventChatMessage, workspaceID, d.actorType, d.actorID, sessionID, protocol.ChatMessagePayload{
			ChatSessionID: sessionID,
			MessageID:     uuidToString(sent.Message.ID),
			Role:          kbChatRoleUser,
			Content:       message,
			TaskID:        uuidToString(sent.Task.ID),
			CreatedAt:     timestampToString(sent.Message.CreatedAt),
		})
		out = append(out, kbCommentTrigger{AgentID: t.AgentID, Reason: t.Reason, TaskID: uuidToString(sent.Task.ID), ChatSessionID: sessionID})
	}

	return out, nil
}

// kbReviewChats picks, per agent, the chat it works on a comment in: the
// job's chat for the job's agent (spec 8.6, decision 104) and the chat that
// created the draft for that chat's agent, whoever comments; otherwise the
// chat an earlier comment of the same commenter opened with the agent.
// Agents without one get a new chat named after the merge request.
func (h *Handler) kbReviewChats(ctx context.Context, d kbReviewDispatch, origin db.ListKbMergeRequestOriginsRow) (map[string]db.ChatSession, error) {
	shared := map[pgtype.UUID]bool{}
	if origin.JobID.Valid {
		shared[origin.JobChatSessionID] = true
	} else if origin.TaskChatSessionID.Valid {
		shared[origin.TaskChatSessionID] = true
	}
	ids := make([]pgtype.UUID, 0, len(shared))
	for id := range shared {
		ids = append(ids, id)
	}
	for _, c := range d.earlier {
		triggers, err := parseKbCommentTriggers(c.Triggered)
		if err != nil {
			return nil, err
		}
		for _, t := range triggers {
			if t.ChatSessionID != "" {
				ids = append(ids, parseUUID(t.ChatSessionID))
			}
		}
	}
	if len(ids) == 0 {
		return map[string]db.ChatSession{}, nil
	}

	rows, err := h.Queries.ListKbChatSessionsByIDs(ctx, db.ListKbChatSessionsByIDsParams{WorkspaceID: d.base.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, errors.Wrapf(err, "load review chats merge_request_id=%s", uuidToString(d.mr.ID))
	}

	out := make(map[string]db.ChatSession, len(rows))
	for _, session := range rows {
		if session.Status != kbChatStatusActive {
			continue
		}
		agentID := uuidToString(session.AgentID)
		if shared[session.ID] {
			out[agentID] = session
			continue
		}
		if _, taken := out[agentID]; !taken && uuidToString(session.CreatorID) == d.userID {
			out[agentID] = session
		}
	}

	return out, nil
}

// kbChatStatusActive is a chat that takes new messages.
const kbChatStatusActive = "active"

func (h *Handler) createKbReviewChat(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, agent db.Agent, userID string) (db.ChatSession, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.ChatSession{}, errors.Wrap(err, "begin review chat create")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.LockWorkspaceForChatSessionCreate(ctx, base.WorkspaceID); err != nil {
		return db.ChatSession{}, errors.Wrapf(err, "lock workspace workspace_id=%s", uuidToString(base.WorkspaceID))
	}
	session, err := qtx.CreateChatSession(ctx, db.CreateChatSessionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: base.WorkspaceID,
		AgentID:     agent.ID,
		CreatorID:   parseUUID(userID),
		Title:       fmt.Sprintf("#%d %s", mr.Number, mr.Title),
	})
	if err != nil {
		return db.ChatSession{}, errors.Wrapf(err, "create review chat merge_request_id=%s", uuidToString(mr.ID))
	}

	if err := tx.Commit(ctx); err != nil {
		return db.ChatSession{}, errors.Wrap(err, "commit review chat create")
	}

	return session, nil
}

// kbMrCommentResponses renders comments with author and agent names and
// whether each triggered task still runs.
func (h *Handler) kbMrCommentResponses(ctx context.Context, wsUUID pgtype.UUID, rows []db.KbMrComment) ([]KbMrCommentResponse, error) {
	actors := make([]kbActor, 0, 2*len(rows))
	triggers := make([][]kbCommentTrigger, len(rows))
	taskIDs := make([]pgtype.UUID, 0)
	for i, c := range rows {
		actors = append(actors, kbActor{kind: c.AuthorType, id: c.AuthorID})
		list, err := parseKbCommentTriggers(c.Triggered)
		if err != nil {
			return nil, err
		}
		triggers[i] = list
		for _, t := range list {
			actors = append(actors, kbActor{kind: kbActorAgent, id: parseUUID(t.AgentID)})
			if t.TaskID != "" {
				taskIDs = append(taskIDs, parseUUID(t.TaskID))
			}
		}
	}

	names, err := h.loadKbActorNames(ctx, wsUUID, actors)
	if err != nil {
		return nil, err
	}
	running, err := h.kbRunningTasks(ctx, taskIDs)
	if err != nil {
		return nil, err
	}

	out := make([]KbMrCommentResponse, len(rows))
	for i, c := range rows {
		resp := KbMrCommentResponse{
			ID:             uuidToString(c.ID),
			MergeRequestID: uuidToString(c.MergeRequestID),
			ParentID:       uuidToPtr(c.ParentID),
			Body:           c.Body,
			AuthorType:     c.AuthorType,
			AuthorID:       uuidToString(c.AuthorID),
			AuthorName:     names.name(c.AuthorType, c.AuthorID),
			Triggered:      make([]KbMrCommentTriggerResponse, 0, len(triggers[i])),
			CreatedAt:      timestampToString(c.CreatedAt),
		}
		if c.QuoteBlockID != "" {
			resp.Quote = &KbMrCommentQuote{PageID: uuidOrEmpty(c.QuotePageID), BlockID: c.QuoteBlockID, Text: c.QuoteText}
		}
		for _, t := range triggers[i] {
			entry := KbMrCommentTriggerResponse{
				AgentID:   t.AgentID,
				AgentName: names.name(kbActorAgent, parseUUID(t.AgentID)),
				Reason:    t.Reason,
				Running:   running[t.TaskID],
			}
			if t.ChatSessionID != "" {
				id := t.ChatSessionID
				entry.ChatSessionID = &id
			}
			if t.TaskID != "" {
				id := t.TaskID
				entry.TaskID = &id
			}
			resp.Triggered = append(resp.Triggered, entry)
		}
		out[i] = resp
	}

	return out, nil
}

// kbRunningTasks reports which of the tasks are queued or running.
func (h *Handler) kbRunningTasks(ctx context.Context, ids []pgtype.UUID) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}

	rows, err := h.Queries.ListKbTaskStatuses(ctx, ids)
	if err != nil {
		return nil, errors.Wrap(err, "list triggered task statuses")
	}
	for _, row := range rows {
		out[uuidToString(row.ID)] = slices.Contains(kbRunningTaskStatuses, row.Status)
	}

	return out, nil
}

// kbReviewAgentsRunning reports whether an agent a review comment started
// is still working.
func (h *Handler) kbReviewAgentsRunning(ctx context.Context, mr db.KbMergeRequest) (bool, error) {
	rows, err := h.Queries.ListKbMrComments(ctx, mr.ID)
	if err != nil {
		return false, errors.Wrapf(err, "list comments merge_request_id=%s", uuidToString(mr.ID))
	}

	taskIDs := make([]pgtype.UUID, 0)
	for _, c := range rows {
		triggers, err := parseKbCommentTriggers(c.Triggered)
		if err != nil {
			return false, err
		}
		for _, t := range triggers {
			if t.TaskID != "" {
				taskIDs = append(taskIDs, parseUUID(t.TaskID))
			}
		}
	}
	running, err := h.kbRunningTasks(ctx, taskIDs)
	if err != nil {
		return false, err
	}
	for _, r := range running {
		if r {
			return true, nil
		}
	}

	return false, nil
}
