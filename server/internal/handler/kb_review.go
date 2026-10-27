package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Origin types (spec 7.13), in the order a merge request decides them. A
// draft's origin in the reading page's draft switcher uses the same words.
const (
	kbOriginJob          = "kb_job"
	kbOriginRevert       = "revert"
	kbOriginAutopilotRun = "autopilot_run"
	kbOriginIssue        = "issue"
	kbOriginChat         = "chat"
	kbOriginNone         = "none"
)

// kbMergeRequestStatusAll lists every status (status=all).
const kbMergeRequestStatusAll = "all"

// Page size of GET /api/kb/merge-requests.
const (
	kbMergeRequestListDefault = 50
	kbMergeRequestListMax     = 100
)

var kbMergeRequestStatuses = []string{kb.MergeRequestStatusOpen, kb.MergeRequestStatusMerged, kb.MergeRequestStatusClosed}

// KbMergeRequestOriginResponse says where a merge request was started.
type KbMergeRequestOriginResponse struct {
	Type  string  `json:"type"`
	Label string  `json:"label"`
	RefID *string `json:"ref_id"`
	// Openable tells whether the viewer may open the origin: a job only
	// opens for the member who started it, a chat only for its creator.
	Openable bool `json:"openable"`
	// openTo is the only member who may open a job or chat origin.
	openTo pgtype.UUID
}

// restrictTo settles Openable for the viewer of a list or detail read.
func (o *KbMergeRequestOriginResponse) restrictTo(viewerID string) {
	if o.openTo.Valid {
		o.Openable = uuidToString(o.openTo) == viewerID
	}
}

// KbMergeRequestResponse is one merge request.
type KbMergeRequestResponse struct {
	ID              string                       `json:"id"`
	Number          int                          `json:"number"`
	KnowledgeBaseID string                       `json:"knowledge_base_id"`
	Title           string                       `json:"title"`
	Summary         string                       `json:"summary"`
	Source          string                       `json:"source"`
	Status          string                       `json:"status"`
	Risk            string                       `json:"risk"`
	AuthorType      string                       `json:"author_type"`
	AuthorID        string                       `json:"author_id"`
	AuthorName      string                       `json:"author_name"`
	DraftID         string                       `json:"draft_id"`
	DraftVersion    int64                        `json:"draft_version"`
	AnnotationIDs   []string                     `json:"annotation_ids"`
	Origin          KbMergeRequestOriginResponse `json:"origin"`
	JobID           *string                      `json:"job_id"`
	Reverts         *int                         `json:"reverts"`
	MergedBy        *string                      `json:"merged_by"`
	MergedByName    string                       `json:"merged_by_name"`
	MergedAt        *string                      `json:"merged_at"`
	ClosedBy        *string                      `json:"closed_by"`
	ClosedByName    string                       `json:"closed_by_name"`
	ClosedAt        *string                      `json:"closed_at"`
	CloseReason     string                       `json:"close_reason"`
	CreatedAt       string                       `json:"created_at"`
	UpdatedAt       string                       `json:"updated_at"`
	// Mention is pasted into a reply to show the merge request card (7.14).
	Mention string `json:"mention"`
}

// KbMergeRequestDetailResponse is a merge request with its file cards,
// checks and what the viewer may do (GET /api/kb/merge-requests/{number}).
type KbMergeRequestDetailResponse struct {
	KbMergeRequestResponse
	KnowledgeBaseSlug string                      `json:"knowledge_base_slug"`
	KnowledgeBaseName string                      `json:"knowledge_base_name"`
	Pages             []KbDraftPageChangeResponse `json:"pages"`
	Checks            KbDraftChecksResponse       `json:"checks"`
	// ReviewAgent is the agent a plain review comment goes to (the author
	// agent, else the job's or the draft task's agent); null when none.
	ReviewAgent *KbReviewAgentResponse `json:"review_agent"`
	// AgentRunning is set while the job's agent, or an agent a review comment
	// started, is still working on the draft.
	AgentRunning bool `json:"agent_running"`
	CanMerge     bool `json:"can_merge"`
	CanClose     bool `json:"can_close"`
	CanRevert    bool `json:"can_revert"`
}

// KbReviewAgentResponse names the agent behind a merge request.
type KbReviewAgentResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// UpdateKbMergeRequestRequest changes a merge request's title, summary or
// risk (PATCH /api/kb/merge-requests/{number}; kb mr update).
type UpdateKbMergeRequestRequest struct {
	Title   *string `json:"title"`
	Summary *string `json:"summary"`
	Risk    *string `json:"risk"`
}

// loadKbMergeRequest loads the {number} URL param, a workspace merge request
// number or id, with its knowledge base.
func (h *Handler) loadKbMergeRequest(w http.ResponseWriter, r *http.Request) (db.KbMergeRequest, db.KbBase, bool) {
	ctx := r.Context()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbMergeRequest{}, db.KbBase{}, false
	}

	ref := chi.URLParam(r, "number")
	var (
		mr  db.KbMergeRequest
		err error
	)
	if n, parseErr := strconv.ParseInt(ref, 10, 32); parseErr == nil {
		mr, err = h.Queries.GetKbMergeRequestByNumber(ctx, db.GetKbMergeRequestByNumberParams{WorkspaceID: wsUUID, Number: int32(n)})
	} else if id, parseErr := util.ParseUUID(ref); parseErr == nil {
		mr, err = h.Queries.GetKbMergeRequestInWorkspace(ctx, db.GetKbMergeRequestInWorkspaceParams{WorkspaceID: wsUUID, ID: id})
	} else {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "merge request must be a number or an id")
		return db.KbMergeRequest{}, db.KbBase{}, false
	}
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeMergeRequestNotFound, "merge request not found")
			return db.KbMergeRequest{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load merge request ref=%q", ref))
		return db.KbMergeRequest{}, db.KbBase{}, false
	}

	base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: mr.KnowledgeBaseID})
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeMergeRequestNotFound, "merge request not found")
			return db.KbMergeRequest{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of merge request merge_request_id=%s", uuidToString(mr.ID)))
		return db.KbMergeRequest{}, db.KbBase{}, false
	}

	return mr, base, true
}

// ListKbMergeRequests lists merge requests (GET /api/kb/merge-requests):
// status is open (default), merged, closed, all or a comma list of them;
// kb narrows to one knowledge base. The change log is status=merged.
func (h *Handler) ListKbMergeRequests(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}

	query := r.URL.Query()
	statuses, ok := parseKbMergeRequestStatuses(w, query.Get("status"))
	if !ok {
		return
	}
	limit, ok := parseKbBoundedInt(w, query.Get("limit"), "limit", kbMergeRequestListDefault, kbMergeRequestListMax)
	if !ok {
		return
	}
	offset, ok := parseKbBoundedInt(w, query.Get("offset"), "offset", 0, -1)
	if !ok {
		return
	}

	var baseID pgtype.UUID
	if ref := strings.TrimSpace(query.Get("kb")); ref != "" {
		base, ok := h.loadKbBaseForUser(w, r, ref)
		if !ok {
			return
		}
		baseID = base.ID
	}

	rows, err := h.Queries.ListKbMergeRequests(ctx, db.ListKbMergeRequestsParams{
		WorkspaceID:     wsUUID,
		Statuses:        statuses,
		KnowledgeBaseID: baseID,
		RowLimit:        int32(limit),
		RowOffset:       int32(offset),
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "list merge requests"))
		return
	}
	resp, err := h.kbMergeRequestResponses(ctx, wsUUID, rows)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if userID := requestUserID(r); userID != "" {
		for i := range resp {
			resp[i].Origin.restrictTo(userID)
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

func parseKbMergeRequestStatuses(w http.ResponseWriter, raw string) ([]string, bool) {
	raw = strings.TrimSpace(raw)
	switch raw {
	case "":
		return []string{kb.MergeRequestStatusOpen}, true
	case kbMergeRequestStatusAll:
		return kbMergeRequestStatuses, true
	}

	out := make([]string, 0, len(kbMergeRequestStatuses))
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if !slices.Contains(kbMergeRequestStatuses, s) {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "status must be open, merged, closed or all")
			return nil, false
		}
		out = append(out, s)
	}

	return out, true
}

// parseKbBoundedInt reads an optional non-negative integer query parameter;
// max < 0 means unbounded, larger values are capped.
func parseKbBoundedInt(w http.ResponseWriter, raw, name string, def, max int) (int, bool) {
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, name+" must be a non-negative integer")
		return 0, false
	}
	if max >= 0 && n > max {
		n = max
	}

	return n, true
}

// GetKbMergeRequest returns a merge request with a file card per changed
// page, its checks, and, while open, a trial merge against the current
// mainline so conflicts show before anyone presses merge (spec 7.9).
func (h *Handler) GetKbMergeRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, uuidToString(base.WorkspaceID))
	if !ok {
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))

	detail, err := h.kbMergeRequestDetail(ctx, base, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	detail.CanMerge = canMaintainKb(member, base)
	detail.CanRevert = detail.CanMerge
	detail.CanClose = canCloseKbMergeRequest(member, base, mr, actorType, actorID)
	detail.Origin.restrictTo(userID)

	writeJSON(w, http.StatusOK, detail)
}

func (h *Handler) kbMergeRequestDetail(ctx context.Context, base db.KbBase, mr db.KbMergeRequest) (KbMergeRequestDetailResponse, error) {
	responses, err := h.kbMergeRequestResponses(ctx, base.WorkspaceID, []db.KbMergeRequest{mr})
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	detail := KbMergeRequestDetailResponse{
		KbMergeRequestResponse: responses[0],
		KnowledgeBaseSlug:      base.Slug,
		KnowledgeBaseName:      base.Name,
		Checks:                 KbDraftChecksResponse{Lint: []lint.Finding{}, Conflicts: []KbDraftConflictResponse{}},
	}

	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, mr.DraftID)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	pages, err := h.kbDraftChanges(ctx, base, overlay)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	detail.Pages = pages

	reviewAgent, err := h.kbReviewAgent(ctx, mr)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	detail.ReviewAgent = reviewAgent

	if mr.Status != kb.MergeRequestStatusOpen {
		return detail, nil
	}

	findings, err := lintKbDraftPages(ctx, h.Queries, base, overlay, nil)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	pageIDs := make([]pgtype.UUID, 0, len(overlay.order))
	for _, id := range overlay.order {
		pageIDs = append(pageIDs, parseUUID(id))
	}
	mainPages, err := h.Queries.ListKbPagesByIDs(ctx, db.ListKbPagesByIDsParams{KnowledgeBaseID: base.ID, Ids: pageIDs})
	if err != nil {
		return KbMergeRequestDetailResponse{}, errors.Wrapf(err, "list mainline pages merge_request_id=%s", uuidToString(mr.ID))
	}
	plan, err := planKbMerge(ctx, h.Queries, base, overlay, mainPages)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	detail.Checks = KbDraftChecksResponse{Lint: findings, Conflicts: plan.conflicts}

	running, err := h.kbMergeRequestJobRunning(ctx, mr)
	if err != nil {
		return KbMergeRequestDetailResponse{}, err
	}
	if !running {
		running, err = h.kbReviewAgentsRunning(ctx, mr)
		if err != nil {
			return KbMergeRequestDetailResponse{}, err
		}
	}
	detail.AgentRunning = running

	return detail, nil
}

// kbReviewAgent names the agent a plain review comment starts.
func (h *Handler) kbReviewAgent(ctx context.Context, mr db.KbMergeRequest) (*KbReviewAgentResponse, error) {
	origins, err := h.Queries.ListKbMergeRequestOrigins(ctx, db.ListKbMergeRequestOriginsParams{WorkspaceID: mr.WorkspaceID, DraftIds: []pgtype.UUID{mr.DraftID}})
	if err != nil {
		return nil, errors.Wrapf(err, "load merge request origin merge_request_id=%s", uuidToString(mr.ID))
	}
	var origin db.ListKbMergeRequestOriginsRow
	if len(origins) > 0 {
		origin = origins[0]
	}
	agentID := kbReviewAgentID(mr, origin)
	if !agentID.Valid {
		return nil, nil
	}

	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, []kbActor{{kind: kbActorAgent, id: agentID}})
	if err != nil {
		return nil, err
	}

	return &KbReviewAgentResponse{ID: uuidToString(agentID), Name: names.name(kbActorAgent, agentID)}, nil
}

// kbReviewAgentID is the agent behind a merge request: its author when an
// agent wrote it, else the agent of the job it came from or of the task
// that created its draft.
func kbReviewAgentID(mr db.KbMergeRequest, origin db.ListKbMergeRequestOriginsRow) pgtype.UUID {
	switch {
	case mr.AuthorType == kbActorAgent:
		return mr.AuthorID
	case origin.JobAgentID.Valid:
		return origin.JobAgentID
	}

	return origin.TaskAgentID
}

// kbMergeRequestResponseOf renders one merge request.
func (h *Handler) kbMergeRequestResponseOf(ctx context.Context, mr db.KbMergeRequest) (KbMergeRequestResponse, error) {
	responses, err := h.kbMergeRequestResponses(ctx, mr.WorkspaceID, []db.KbMergeRequest{mr})
	if err != nil {
		return KbMergeRequestResponse{}, err
	}

	return responses[0], nil
}

// kbMergeRequestResponses renders merge requests with their draft versions,
// names and origins, batch-loading each in one query.
func (h *Handler) kbMergeRequestResponses(ctx context.Context, wsUUID pgtype.UUID, mrs []db.KbMergeRequest) ([]KbMergeRequestResponse, error) {
	out := make([]KbMergeRequestResponse, 0, len(mrs))
	if len(mrs) == 0 {
		return out, nil
	}

	actors := make([]kbActor, 0, 3*len(mrs))
	draftIDs := make([]pgtype.UUID, 0, len(mrs))
	revertIDs := make([]pgtype.UUID, 0)
	for _, mr := range mrs {
		actors = append(actors,
			kbActor{kind: mr.AuthorType, id: mr.AuthorID},
			kbActor{kind: kbActorMember, id: mr.MergedBy},
			kbActor{kind: kbActorMember, id: mr.ClosedBy},
		)
		draftIDs = append(draftIDs, mr.DraftID)
		if mr.RevertsID.Valid {
			revertIDs = append(revertIDs, mr.RevertsID)
		}
	}

	names, err := h.loadKbActorNames(ctx, wsUUID, actors)
	if err != nil {
		return nil, err
	}
	drafts, err := h.Queries.ListKbDraftsByIDs(ctx, db.ListKbDraftsByIDsParams{WorkspaceID: wsUUID, Ids: draftIDs})
	if err != nil {
		return nil, errors.Wrap(err, "list merge request drafts")
	}
	versions := make(map[pgtype.UUID]int64, len(drafts))
	for _, d := range drafts {
		versions[d.ID] = d.Version
	}
	originRows, err := h.Queries.ListKbMergeRequestOrigins(ctx, db.ListKbMergeRequestOriginsParams{WorkspaceID: wsUUID, DraftIds: draftIDs})
	if err != nil {
		return nil, errors.Wrap(err, "list merge request origins")
	}
	origins := make(map[pgtype.UUID]db.ListKbMergeRequestOriginsRow, len(originRows))
	for _, row := range originRows {
		origins[row.DraftID] = row
	}
	reverted := map[pgtype.UUID]db.KbMergeRequest{}
	if len(revertIDs) > 0 {
		rows, err := h.Queries.ListKbMergeRequestsByIDs(ctx, db.ListKbMergeRequestsByIDsParams{WorkspaceID: wsUUID, Ids: revertIDs})
		if err != nil {
			return nil, errors.Wrap(err, "list reverted merge requests")
		}
		for _, row := range rows {
			reverted[row.ID] = row
		}
	}

	for _, mr := range mrs {
		resp := KbMergeRequestResponse{
			ID:              uuidToString(mr.ID),
			Number:          int(mr.Number),
			KnowledgeBaseID: uuidToString(mr.KnowledgeBaseID),
			Title:           mr.Title,
			Summary:         mr.Summary,
			Source:          mr.Source,
			Status:          mr.Status,
			Risk:            mr.Risk,
			AuthorType:      mr.AuthorType,
			AuthorID:        uuidToString(mr.AuthorID),
			AuthorName:      names.name(mr.AuthorType, mr.AuthorID),
			DraftID:         uuidToString(mr.DraftID),
			DraftVersion:    versions[mr.DraftID],
			AnnotationIDs:   make([]string, len(mr.AnnotationIds)),
			JobID:           uuidToPtr(mr.JobID),
			MergedBy:        uuidToPtr(mr.MergedBy),
			MergedByName:    names.name(kbActorMember, mr.MergedBy),
			ClosedBy:        uuidToPtr(mr.ClosedBy),
			ClosedByName:    names.name(kbActorMember, mr.ClosedBy),
			CloseReason:     mr.CloseReason,
			CreatedAt:       timestampToString(mr.CreatedAt),
			UpdatedAt:       timestampToString(mr.UpdatedAt),
			Mention:         kbMergeRequestMention(mr),
		}
		for i, id := range mr.AnnotationIds {
			resp.AnnotationIDs[i] = uuidToString(id)
		}
		if mr.MergedAt.Valid {
			at := timestampToString(mr.MergedAt)
			resp.MergedAt = &at
		}
		if mr.ClosedAt.Valid {
			at := timestampToString(mr.ClosedAt)
			resp.ClosedAt = &at
		}
		var revertedMR *db.KbMergeRequest
		if mr.RevertsID.Valid {
			if row, ok := reverted[mr.RevertsID]; ok {
				number := int(row.Number)
				resp.Reverts = &number
				revertedMR = &row
			}
		}
		resp.Origin = kbMergeRequestOrigin(mr, origins[mr.DraftID], revertedMR)
		out = append(out, resp)
	}

	return out, nil
}

// kbMergeRequestOrigin decides where a merge request came from, in the
// order of spec 7.13: the linked job, the request it reverts, the task that
// created the draft (its autopilot run, issue or chat), else none. The
// label is the object's own name; clients add the kind in front.
func kbMergeRequestOrigin(mr db.KbMergeRequest, row db.ListKbMergeRequestOriginsRow, reverted *db.KbMergeRequest) KbMergeRequestOriginResponse {
	switch {
	case row.JobID.Valid:
		return KbMergeRequestOriginResponse{Type: kbOriginJob, Label: row.JobName, RefID: uuidToPtr(row.JobID), Openable: true, openTo: row.JobCreatedBy}
	case mr.RevertsID.Valid:
		label := ""
		if reverted != nil {
			label = fmt.Sprintf("#%d %s", reverted.Number, reverted.Title)
		}

		return KbMergeRequestOriginResponse{Type: kbOriginRevert, Label: label, RefID: uuidToPtr(mr.RevertsID), Openable: true}
	case row.TaskAutopilotRunID.Valid:
		// The autopilot page lists its runs; there is no page per run.
		return KbMergeRequestOriginResponse{Type: kbOriginAutopilotRun, Label: row.AutopilotTitle, RefID: uuidToPtr(row.AutopilotID), Openable: true}
	case row.TaskIssueID.Valid:
		return KbMergeRequestOriginResponse{Type: kbOriginIssue, Label: row.IssueTitle, RefID: uuidToPtr(row.TaskIssueID), Openable: true}
	case row.TaskChatSessionID.Valid:
		return KbMergeRequestOriginResponse{Type: kbOriginChat, Label: row.ChatTitle, RefID: uuidToPtr(row.TaskChatSessionID), Openable: true, openTo: row.ChatCreatorID}
	}

	return KbMergeRequestOriginResponse{Type: kbOriginNone}
}

// kbMergeRequestMention renders [#16 title](mention://kb_mr/<id>).
func kbMergeRequestMention(mr db.KbMergeRequest) string {
	label := fmt.Sprintf("#%d %s", mr.Number, mr.Title)

	return "[" + mentionLabelEscaper.Replace(label) + "](mention://kb_mr/" + uuidToString(mr.ID) + ")"
}

// UpdateKbMergeRequest changes the title, summary or risk of an open merge
// request (PATCH /api/kb/merge-requests/{number}). The content follows the
// draft by itself.
func (h *Handler) UpdateKbMergeRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req UpdateKbMergeRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, uuidToString(base.WorkspaceID))
	if !ok {
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	if !canCloseKbMergeRequest(member, base, mr, actorType, actorID) {
		h.writeKbError(w, r, kbFail(http.StatusForbidden, kbCodeForbidden, "only the author, the knowledge base creator or an owner or admin can edit this merge request"))
		return
	}
	if mr.Status != kb.MergeRequestStatusOpen {
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+mr.Status)
		return
	}

	params := db.UpdateKbMergeRequestTextParams{ID: mr.ID, Title: mr.Title, Summary: mr.Summary, Risk: mr.Risk}
	if req.Title != nil {
		params.Title = strings.TrimSpace(*req.Title)
		if params.Title == "" {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidMergeRequest, "title cannot be empty")
			return
		}
	}
	if req.Summary != nil {
		params.Summary = strings.TrimSpace(*req.Summary)
	}
	if req.Risk != nil {
		if !kb.IsMergeRequestRisk(*req.Risk) {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidMergeRequest, "risk must be low, medium or high")
			return
		}
		params.Risk = *req.Risk
	}

	updated, err := h.Queries.UpdateKbMergeRequestText(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "update merge request merge_request_id=%s", uuidToString(mr.ID)))
		return
	}

	h.publishKbMergeRequestEvent(protocol.EventKbMrUpdated, updated, actorType, actorID, nil)

	resp, err := h.kbMergeRequestResponseOf(ctx, updated)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
