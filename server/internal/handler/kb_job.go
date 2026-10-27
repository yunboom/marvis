package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	obsmetrics "github.com/yunboom/marvis/server/internal/metrics"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Job states (spec 7.10): not stored, read off the chat's latest task.
const (
	kbJobStateRunning = "running"
	kbJobStateIdle    = "idle"
	kbJobStateFailed  = "failed"
	kbJobStateStopped = "stopped"
)

// kbChatSessionArchived is the chat_session status of an archived job: the
// job's chat carries its archived flag, so archiving a job and archiving its
// chat are one write.
const kbChatSessionArchived = "archived"

// Terminal statuses of agent_task_queue a job state is derived from.
const (
	kbTaskFailed    = "failed"
	kbTaskCancelled = "cancelled"
)

// Error codes of the job endpoints.
const (
	kbCodeJobNoDraft          = "job_no_draft"
	kbCodeJobRunning          = "job_running"
	kbCodeDraftCheckFailed    = "draft_check_failed"
	kbCodeDraftEmpty          = "draft_empty"
	kbCodeMergeRequestOpen    = "merge_request_open"
	kbCodeAnnotationNotFound  = "annotation_not_found"
	kbCodeAgentUnavailable    = "agent_unavailable"
	kbCodeMergeRequestMerged  = "merge_request_merged"
	kbCodeInvalidJobStarter   = "invalid_starter"
	kbCodeInvalidMergeRequest = "invalid_merge_request"
)

// kbJobListLimit caps a member's job list; the list is per member and per
// knowledge base, so it stays short.
const kbJobListLimit = 200

// kbLastReplyRunes is how much of the agent's last reply a job row shows.
const kbLastReplyRunes = 140

// kbMergeRequestTitleRunes caps a merge request title taken from a reply.
const kbMergeRequestTitleRunes = 120

// kbWholeBaseWhere is how an annotation on the whole knowledge base is named
// in a job's first message.
const kbWholeBaseWhere = "knowledge base"

var kbJobStates = []string{kbJobStateRunning, kbJobStateFailed}

// CreateKbJobRequest starts a job (POST /api/kb/bases/{kb}/jobs).
type CreateKbJobRequest struct {
	AgentID       string   `json:"agent_id"`
	Starter       string   `json:"starter"`
	Name          string   `json:"name"`
	Message       string   `json:"message"`
	AnnotationIDs []string `json:"annotation_ids"`
	PageID        *string  `json:"page_id"`
	// Sources are the uris of the material an ingest job starts from.
	Sources []string `json:"sources"`
}

// KbJobDraftSummary is the linked draft at a glance. Added and deleted are
// only counted on the job detail; the list leaves them 0.
type KbJobDraftSummary struct {
	Version int64  `json:"version"`
	Status  string `json:"status"`
	Pages   int    `json:"pages"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

// KbJobMergeRequestSummary is the latest merge request made from the job's
// draft.
type KbJobMergeRequestSummary struct {
	ID           string  `json:"id"`
	Number       int     `json:"number"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	AuthorType   string  `json:"author_type"`
	AuthorID     *string `json:"author_id"`
	AuthorName   string  `json:"author_name"`
	MergedByName string  `json:"merged_by_name"`
	ClosedByName string  `json:"closed_by_name"`
	CloseReason  string  `json:"close_reason"`
}

// KbJobResponse is one knowledge base job.
type KbJobResponse struct {
	ID              string                    `json:"id"`
	KnowledgeBaseID string                    `json:"knowledge_base_id"`
	Name            string                    `json:"name"`
	Starter         string                    `json:"starter"`
	AgentID         string                    `json:"agent_id"`
	AgentName       string                    `json:"agent_name"`
	ChatSessionID   string                    `json:"chat_session_id"`
	DraftID         *string                   `json:"draft_id"`
	CreatedBy       string                    `json:"created_by"`
	State           string                    `json:"state"`
	Archived        bool                      `json:"archived"`
	LastReply       string                    `json:"last_reply"`
	Draft           *KbJobDraftSummary        `json:"draft"`
	MergeRequest    *KbJobMergeRequestSummary `json:"merge_request"`
	AnnotationIDs   []string                  `json:"annotation_ids"`
	PageID          *string                   `json:"page_id"`
	CreatedAt       string                    `json:"created_at"`
	UpdatedAt       string                    `json:"updated_at"`
}

// KbJobDetailResponse is a job with its draft's changes and checks.
type KbJobDetailResponse struct {
	KbJobResponse
	Pages  []KbDraftPageChangeResponse `json:"pages"`
	Checks KbDraftChecksResponse       `json:"checks"`
}

// SubmitKbJobRequest submits a job's draft for review.
type SubmitKbJobRequest struct {
	Title   string `json:"title"`
	Summary string `json:"summary"`
}

// CreateKbMergeRequestRequest opens a merge request for a draft (POST
// /api/kb/merge-requests, kb mr create).
type CreateKbMergeRequestRequest struct {
	DraftID       string   `json:"draft_id"`
	Title         string   `json:"title"`
	Summary       string   `json:"summary"`
	Risk          string   `json:"risk"`
	Source        string   `json:"source"`
	AnnotationIDs []string `json:"annotation_ids"`
}

// ListKbJobs lists the caller's jobs of a knowledge base (GET
// /api/kb/bases/{kb}/jobs), newest first, archived ones included and
// flagged; state=running|failed narrows it to unarchived jobs in that state.
func (h *Handler) ListKbJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	state := r.URL.Query().Get("state")
	if state != "" && !slices.Contains(kbJobStates, state) {
		writeError(w, http.StatusBadRequest, "state must be running or failed")
		return
	}
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	jobs, err := h.Queries.ListKbJobsByCreator(ctx, db.ListKbJobsByCreatorParams{
		KnowledgeBaseID: base.ID,
		CreatedBy:       parseUUID(userID),
		RowLimit:        kbJobListLimit,
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list jobs knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, jobs)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	out := make([]KbJobResponse, 0, len(responses))
	for _, job := range responses {
		if state == "" || (job.State == state && !job.Archived) {
			out = append(out, job)
		}
	}

	writeJSON(w, http.StatusOK, out)
}

// kbJobResponses builds job rows with their derived state in one query.
func (h *Handler) kbJobResponses(ctx context.Context, wsUUID pgtype.UUID, jobs []db.KbJob) ([]KbJobResponse, error) {
	if len(jobs) == 0 {
		return []KbJobResponse{}, nil
	}

	ids := make([]pgtype.UUID, len(jobs))
	for i, job := range jobs {
		ids[i] = job.ID
	}
	rows, err := h.Queries.ListKbJobStates(ctx, db.ListKbJobStatesParams{
		RunningStatuses: kbRunningTaskStatuses,
		ArchivedStatus:  kbChatSessionArchived,
		WorkspaceID:     wsUUID,
		JobIds:          ids,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list job states jobs=%d", len(jobs))
	}
	states := make(map[string]db.ListKbJobStatesRow, len(rows))
	actors := make([]kbActor, 0, 3*len(rows))
	for _, row := range rows {
		states[uuidToString(row.ID)] = row
		actors = append(actors,
			kbActor{kind: row.MrAuthorType, id: row.MrAuthorID},
			kbActor{kind: kbActorMember, id: row.MrMergedBy},
			kbActor{kind: kbActorMember, id: row.MrClosedBy},
		)
	}
	names, err := h.loadKbActorNames(ctx, wsUUID, actors)
	if err != nil {
		return nil, err
	}

	out := make([]KbJobResponse, len(jobs))
	for i, job := range jobs {
		out[i] = kbJobResponse(job, states[uuidToString(job.ID)], names)
	}

	return out, nil
}

func kbJobResponse(job db.KbJob, row db.ListKbJobStatesRow, names kbActorNames) KbJobResponse {
	resp := KbJobResponse{
		ID:              uuidToString(job.ID),
		KnowledgeBaseID: uuidToString(job.KnowledgeBaseID),
		Name:            job.Name,
		Starter:         job.Starter,
		AgentID:         uuidToString(job.AgentID),
		AgentName:       row.AgentName,
		ChatSessionID:   uuidToString(job.ChatSessionID),
		DraftID:         uuidToPtr(row.DraftID),
		CreatedBy:       uuidToString(job.CreatedBy),
		State:           kbJobState(row),
		Archived:        row.Archived,
		LastReply:       kbSnippet(row.LastReply, kbLastReplyRunes),
		AnnotationIDs:   make([]string, len(job.AnnotationIds)),
		PageID:          uuidToPtr(job.PageID),
		CreatedAt:       timestampToString(job.CreatedAt),
		UpdatedAt:       timestampToString(latestTimestamp(job.UpdatedAt, row.LastReplyAt, row.DraftUpdatedAt)),
	}
	for i, id := range job.AnnotationIds {
		resp.AnnotationIDs[i] = uuidToString(id)
	}
	if row.DraftID.Valid {
		resp.Draft = &KbJobDraftSummary{Version: row.DraftVersion, Status: row.DraftStatus, Pages: int(row.DraftPages)}
	}
	if row.MrID.Valid {
		resp.MergeRequest = &KbJobMergeRequestSummary{
			ID:           uuidToString(row.MrID),
			Number:       int(row.MrNumber),
			Title:        row.MrTitle,
			Status:       row.MrStatus,
			AuthorType:   row.MrAuthorType,
			AuthorID:     uuidToPtr(row.MrAuthorID),
			AuthorName:   names.name(row.MrAuthorType, row.MrAuthorID),
			MergedByName: names.name(kbActorMember, row.MrMergedBy),
			ClosedByName: names.name(kbActorMember, row.MrClosedBy),
			CloseReason:  row.MrCloseReason,
		}
	}

	return resp
}

// kbJobState reads a job's state off its chat: a turn in flight is running,
// otherwise the latest task's outcome.
func kbJobState(row db.ListKbJobStatesRow) string {
	switch {
	case row.Running:
		return kbJobStateRunning
	case row.LastTaskStatus == kbTaskFailed:
		return kbJobStateFailed
	case row.LastTaskStatus == kbTaskCancelled:
		return kbJobStateStopped
	default:
		return kbJobStateIdle
	}
}

func latestTimestamp(times ...pgtype.Timestamptz) pgtype.Timestamptz {
	var latest pgtype.Timestamptz
	for _, t := range times {
		if t.Valid && (!latest.Valid || t.Time.After(latest.Time)) {
			latest = t
		}
	}

	return latest
}

// kbSnippet collapses whitespace and cuts text to n runes.
func kbSnippet(text string, n int) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(collapsed) <= n {
		return collapsed
	}

	return string([]rune(collapsed)[:n-1]) + "…"
}

// CreateKbJob starts a job (POST /api/kb/bases/{kb}/jobs): a chat session
// with the chosen agent, a kb_job row and the first message, which the
// server writes from the spec 08.4 / 08.5 templates. No draft is created;
// the agent creates one with kb draft create --job.
func (h *Handler) CreateKbJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "message is required")
		return
	}
	if !kb.IsStarter(req.Starter) {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidJobStarter, "starter is not a known job starter")
		return
	}
	agentID, ok := parseUUIDOrBadRequest(w, req.AgentID, "agent_id")
	if !ok {
		return
	}
	annotationIDs, ok := parseUUIDSliceOrBadRequest(w, req.AnnotationIDs, "annotation_ids")
	if !ok {
		return
	}
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}
	workspaceID := uuidToString(base.WorkspaceID)

	agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: agentID, WorkspaceID: base.WorkspaceID})
	if err != nil || agent.Kind == kbAgentKindSystem {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if agent.ArchivedAt.Valid {
		writeErrorCode(w, http.StatusUnprocessableEntity, kbCodeAgentUnavailable, "agent is archived")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	if !h.canInvokeAgent(ctx, agent, actorType, actorID, h.invokeOriginatorFromRequest(r, actorType, actorID), workspaceID) {
		h.writeDispatchBlocked(w, http.StatusForbidden, ReasonInvocationNotAllowed)
		return
	}
	if verdict, err := service.AgentReadiness(ctx, h.runtimeLookup(obsmetrics.RuntimeLookupSourceChat), agent); err == nil && verdict.Blocked() {
		h.writeDispatchBlocked(w, http.StatusUnprocessableEntity, verdict.Reason)
		return
	}

	input, pageID, err := h.kbJobContext(ctx, base, req, annotationIDs, message)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = kb.DefaultJobName(req.Starter, message)
	}
	input.JobName = name

	job, session, err := h.createKbJobRows(ctx, base, agent, userID, name, req.Starter, annotationIDs, pageID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	input.JobID = uuidToString(job.ID)
	content, err := kb.JobFirstMessage(input)
	if err != nil {
		if discardErr := h.discardKbJobRows(ctx, job, session); discardErr != nil {
			err = errors.Wrapf(discardErr, "discard job after render failure (%v)", err)
		}
		h.writeKbInternalError(w, r, err)
		return
	}
	sent, err := h.TaskService.SendDirectChatMessage(ctx, session, agent, parseUUID(userID), content, nil, actorType, parseUUID(actorID))
	if err != nil {
		// The job is useless without its first message: take it back so the
		// member can retry instead of finding an empty job in the list.
		if discardErr := h.discardKbJobRows(ctx, job, session); discardErr != nil {
			h.writeKbInternalError(w, r, errors.Wrapf(discardErr, "discard job after send failure (%v)", err))
			return
		}
		if errors.Is(err, service.ErrChatTaskAgentNoRuntime) || errors.Is(err, service.ErrChatTaskAgentArchived) {
			writeErrorCode(w, http.StatusUnprocessableEntity, kbCodeAgentUnavailable, "agent cannot run")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "send job first message job_id=%s", uuidToString(job.ID)))
		return
	}

	sessionID := uuidToString(session.ID)
	h.publishChat(protocol.EventChatMessage, workspaceID, kbActorMember, userID, sessionID, protocol.ChatMessagePayload{
		ChatSessionID: sessionID,
		MessageID:     uuidToString(sent.Message.ID),
		Role:          "user",
		Content:       content,
		TaskID:        uuidToString(sent.Task.ID),
		CreatedAt:     timestampToString(sent.Message.CreatedAt),
	})
	h.publishKbJobUpdated(job, actorType, actorID)

	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, []db.KbJob{job})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, responses[0])
}

// kbAgentKindSystem marks the hidden carrier agents, which cannot run jobs.
const kbAgentKindSystem = "system"

// kbJobContext validates what an entry point brought in and fills the
// starter section of the first message with it.
func (h *Handler) kbJobContext(ctx context.Context, base db.KbBase, req CreateKbJobRequest, annotationIDs []pgtype.UUID, message string) (kb.JobMessageInput, pgtype.UUID, error) {
	input := kb.JobMessageInput{Name: base.Name, Slug: base.Slug, Starter: req.Starter, Message: message}

	tree, err := loadKbTreeWith(ctx, h.Queries, base.ID, nil)
	if err != nil {
		return input, pgtype.UUID{}, err
	}
	ref := func(path string) string { return base.Slug + ":" + path }

	var pageID pgtype.UUID
	if req.PageID != nil && *req.PageID != "" {
		id, err := optionalPgUUID(*req.PageID)
		if err != nil {
			return input, pgtype.UUID{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "page_id is not a uuid")
		}
		node, found := tree.Node(uuidToString(id))
		path, hasPath := tree.PathByPageID(uuidToString(id))
		if !found || !hasPath {
			return input, pgtype.UUID{}, kbFail(http.StatusBadRequest, kbCodePageNotFound, "page_id is not a page of this knowledge base")
		}
		pageID = id
		named := node.Title + " (`" + ref(path) + "`)"
		input.Page = named
		input.Pages = named
		input.ParentTitle = node.Title
		input.ParentPath = ref(path)
	}
	if input.ParentPath == "" {
		input.ParentTitle = base.Name
		input.ParentPath = ref("/")
	}

	if len(annotationIDs) > 0 {
		annotations, err := h.kbJobAnnotations(ctx, base, tree, annotationIDs)
		if err != nil {
			return input, pgtype.UUID{}, err
		}
		input.Annotations = annotations
	}

	for _, uri := range req.Sources {
		uri = strings.TrimSpace(uri)
		if uri == "" {
			continue
		}
		input.Sources = append(input.Sources, kb.JobSource{URI: uri, Title: path.Base(uri)})
	}

	return input, pageID, nil
}

// kbJobAnnotations loads the annotations brought into a job; each must be an
// annotation of this knowledge base.
func (h *Handler) kbJobAnnotations(ctx context.Context, base db.KbBase, tree *kb.PageTree, ids []pgtype.UUID) ([]kb.JobAnnotation, error) {
	rows, err := h.Queries.ListKbAnnotationsByIDs(ctx, db.ListKbAnnotationsByIDsParams{KnowledgeBaseID: base.ID, Ids: ids})
	if err != nil {
		return nil, errors.Wrapf(err, "list job annotations knowledge_base_id=%s", uuidToString(base.ID))
	}
	if len(rows) != len(slices.Compact(slices.SortedFunc(slices.Values(ids), compareUUID))) {
		return nil, kbFail(http.StatusBadRequest, kbCodeAnnotationNotFound, "annotation_ids names an annotation outside this knowledge base")
	}

	byID := make(map[string]db.KbAnnotation, len(rows))
	for _, row := range rows {
		byID[uuidToString(row.ID)] = row
	}
	out := make([]kb.JobAnnotation, 0, len(rows))
	for _, id := range ids {
		row, ok := byID[uuidToString(id)]
		if !ok {
			continue
		}
		delete(byID, uuidToString(id))

		where := kbWholeBaseWhere
		if row.PageID.Valid {
			path, _ := tree.PathByPageID(uuidToString(row.PageID))
			where = base.Slug + ":" + path
			if row.BlockID != "" {
				where += "#^" + row.BlockID
			}
			where = "`" + where + "`"
		}
		out = append(out, kb.JobAnnotation{ID: uuidToString(row.ID), Where: where, Quote: row.Quote, Body: row.Body})
	}

	return out, nil
}

func compareUUID(a, b pgtype.UUID) int {
	return strings.Compare(uuidToString(a), uuidToString(b))
}

// createKbJobRows creates the job's chat session and its kb_job row in one
// transaction, under the same workspace lock CreateChatSession takes.
func (h *Handler) createKbJobRows(ctx context.Context, base db.KbBase, agent db.Agent, userID, name, starter string, annotationIDs []pgtype.UUID, pageID pgtype.UUID) (db.KbJob, db.ChatSession, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.KbJob{}, db.ChatSession{}, errors.Wrap(err, "begin job create")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.LockWorkspaceForChatSessionCreate(ctx, base.WorkspaceID); err != nil {
		if isNotFound(err) {
			return db.KbJob{}, db.ChatSession{}, kbFail(http.StatusNotFound, kbCodeKnowledgeBaseNF, "workspace not found")
		}

		return db.KbJob{}, db.ChatSession{}, errors.Wrapf(err, "lock workspace workspace_id=%s", uuidToString(base.WorkspaceID))
	}

	session, err := qtx.CreateChatSession(ctx, db.CreateChatSessionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: base.WorkspaceID,
		AgentID:     agent.ID,
		CreatorID:   parseUUID(userID),
		Title:       name,
	})
	if err != nil {
		return db.KbJob{}, db.ChatSession{}, errors.Wrapf(err, "create job chat session knowledge_base_id=%s", uuidToString(base.ID))
	}

	if annotationIDs == nil {
		annotationIDs = []pgtype.UUID{}
	}
	job, err := qtx.CreateKbJob(ctx, db.CreateKbJobParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Name:            name,
		Starter:         starter,
		AgentID:         agent.ID,
		ChatSessionID:   session.ID,
		AnnotationIds:   annotationIDs,
		PageID:          pageID,
		CreatedBy:       parseUUID(userID),
	})
	if err != nil {
		return db.KbJob{}, db.ChatSession{}, errors.Wrapf(err, "create job knowledge_base_id=%s", uuidToString(base.ID))
	}

	if err := tx.Commit(ctx); err != nil {
		return db.KbJob{}, db.ChatSession{}, errors.Wrap(err, "commit job create")
	}

	return job, session, nil
}

// discardKbJobRows removes a job whose first message could not be sent. The
// session has no message and no task, so nothing else references it.
func (h *Handler) discardKbJobRows(ctx context.Context, job db.KbJob, session db.ChatSession) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return errors.Wrapf(err, "begin job discard job_id=%s", uuidToString(job.ID))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.LockChatSessionForDelete(ctx, session.ID); err != nil {
		return errors.Wrapf(err, "lock job chat session chat_session_id=%s", uuidToString(session.ID))
	}
	if err := qtx.DeleteKbJob(ctx, db.DeleteKbJobParams{WorkspaceID: job.WorkspaceID, ID: job.ID}); err != nil {
		return errors.Wrapf(err, "delete job job_id=%s", uuidToString(job.ID))
	}
	if err := qtx.DeleteChatSession(ctx, db.DeleteChatSessionParams{ID: session.ID, WorkspaceID: session.WorkspaceID}); err != nil {
		return errors.Wrapf(err, "delete job chat session chat_session_id=%s", uuidToString(session.ID))
	}

	return errors.Wrapf(tx.Commit(ctx), "commit job discard job_id=%s", uuidToString(job.ID))
}

func (h *Handler) publishKbJobUpdated(job db.KbJob, actorType, actorID string, draftID ...pgtype.UUID) {
	var draft any
	if len(draftID) > 0 && draftID[0].Valid {
		draft = uuidToString(draftID[0])
	}

	h.publish(protocol.EventKbJobUpdated, uuidToString(job.WorkspaceID), actorType, actorID, map[string]any{
		"job_id":            uuidToString(job.ID),
		"knowledge_base_id": uuidToString(job.KnowledgeBaseID),
		"draft_id":          draft,
	})
}

// loadKbJobForCreator loads the job of the {id} URL param; only the member
// who started it may see or act on it.
func (h *Handler) loadKbJobForCreator(w http.ResponseWriter, r *http.Request) (db.KbJob, db.KbBase, bool) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return db.KbJob{}, db.KbBase{}, false
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbJob{}, db.KbBase{}, false
	}
	jobID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "jobId"), "id")
	if !ok {
		return db.KbJob{}, db.KbBase{}, false
	}

	job, err := h.Queries.GetKbJobInWorkspace(ctx, db.GetKbJobInWorkspaceParams{WorkspaceID: wsUUID, ID: jobID})
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeJobNotFound, "job not found")
			return db.KbJob{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load job job_id=%s", uuidToString(jobID)))
		return db.KbJob{}, db.KbBase{}, false
	}
	if uuidToString(job.CreatedBy) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeForbidden, "only the member who started the job can open it")
		return db.KbJob{}, db.KbBase{}, false
	}

	base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: job.KnowledgeBaseID})
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeJobNotFound, "job not found")
			return db.KbJob{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of job job_id=%s", uuidToString(job.ID)))
		return db.KbJob{}, db.KbBase{}, false
	}

	return job, base, true
}

// GetKbJob returns a job with its draft's changes and checks (GET
// /api/kb/jobs/{id}). Before the agent links a draft, draft and draft_id are
// null and pages and checks are empty.
func (h *Handler) GetKbJob(w http.ResponseWriter, r *http.Request) {
	job, base, ok := h.loadKbJobForCreator(w, r)
	if !ok {
		return
	}

	detail, err := h.kbJobDetail(r.Context(), base, job)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, detail)
}

func (h *Handler) kbJobDetail(ctx context.Context, base db.KbBase, job db.KbJob) (KbJobDetailResponse, error) {
	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, []db.KbJob{job})
	if err != nil {
		return KbJobDetailResponse{}, err
	}
	detail := KbJobDetailResponse{
		KbJobResponse: responses[0],
		Pages:         []KbDraftPageChangeResponse{},
		Checks:        KbDraftChecksResponse{Lint: []lint.Finding{}, Conflicts: []KbDraftConflictResponse{}},
	}
	if detail.DraftID == nil {
		return detail, nil
	}

	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, parseUUID(*detail.DraftID))
	if err != nil {
		return KbJobDetailResponse{}, err
	}
	pages, err := h.kbDraftChanges(ctx, base, overlay)
	if err != nil {
		return KbJobDetailResponse{}, err
	}
	findings, err := lintKbDraftPages(ctx, h.Queries, base, overlay, nil)
	if err != nil {
		return KbJobDetailResponse{}, err
	}

	detail.Pages = pages
	detail.Checks = KbDraftChecksResponse{Lint: findings, Conflicts: kbDraftConflicts(overlay)}
	for _, page := range pages {
		detail.Draft.Added += page.Added
		detail.Draft.Deleted += page.Deleted
	}

	return detail, nil
}

// SubmitKbJob submits the job's draft for review (POST
// /api/kb/jobs/{id}/submit): it opens a merge request from the linked draft
// and moves the annotations the job brought in to processing.
func (h *Handler) SubmitKbJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	job, base, ok := h.loadKbJobForCreator(w, r)
	if !ok {
		return
	}

	var req SubmitKbJobRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, []db.KbJob{job})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	current := responses[0]
	if current.DraftID == nil {
		writeErrorCode(w, http.StatusConflict, kbCodeJobNoDraft, "the agent has not created the job's draft yet")
		return
	}
	if current.State == kbJobStateRunning {
		writeErrorCode(w, http.StatusConflict, kbCodeJobRunning, "the agent is still working on this turn")
		return
	}

	title, summary, err := h.kbJobSubmitText(ctx, job, req)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	userID := requestUserID(r)
	created, draft, err := h.openKbMergeRequest(ctx, base, parseUUID(*current.DraftID), kbOpenMergeRequest{
		title:         title,
		summary:       summary,
		source:        kb.StarterSource(job.Starter),
		risk:          kb.MergeRequestRiskLow,
		authorType:    kbActorMember,
		authorID:      parseUUID(userID),
		job:           &job,
		annotationIDs: job.AnnotationIds,
	})
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestCreated(created, draft, &job, kbActorMember, userID)

	resp, err := h.kbMergeRequestResponseOf(ctx, created.MergeRequest)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

// kbJobSubmitText is the merge request title and summary of a job submit:
// what the member typed, else the agent's last reply (its first line as the
// title), else the job name.
func (h *Handler) kbJobSubmitText(ctx context.Context, job db.KbJob, req SubmitKbJobRequest) (string, string, error) {
	title := strings.TrimSpace(req.Title)
	summary := strings.TrimSpace(req.Summary)
	if title != "" && summary != "" {
		return title, summary, nil
	}

	rows, err := h.Queries.ListKbJobStates(ctx, db.ListKbJobStatesParams{
		RunningStatuses: kbRunningTaskStatuses,
		ArchivedStatus:  kbChatSessionArchived,
		WorkspaceID:     job.WorkspaceID,
		JobIds:          []pgtype.UUID{job.ID},
	})
	if err != nil {
		return "", "", errors.Wrapf(err, "load last reply job_id=%s", uuidToString(job.ID))
	}
	reply := ""
	if len(rows) > 0 {
		reply = strings.TrimSpace(rows[0].LastReply)
	}

	if summary == "" {
		summary = reply
	}
	if title == "" {
		title = kbTitleFromReply(reply)
	}
	if title == "" {
		title = job.Name
	}

	return title, summary, nil
}

// kbTitleFromReply takes the first non-empty line of a reply, without the
// Markdown heading and emphasis marks around it.
func kbTitleFromReply(reply string) string {
	for _, line := range strings.Split(reply, "\n") {
		line = strings.TrimSpace(strings.Trim(strings.TrimSpace(line), "#*_>` "))
		if line != "" {
			return kbSnippet(line, kbMergeRequestTitleRunes)
		}
	}

	return ""
}

// DiscardKbJob discards the job's draft (POST /api/kb/jobs/{id}/discard).
// The job stays listed and shows the draft as discarded.
func (h *Handler) DiscardKbJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	job, base, ok := h.loadKbJobForCreator(w, r)
	if !ok {
		return
	}

	link, err := h.Queries.GetKbJobDraftByJob(ctx, job.ID)
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusConflict, kbCodeJobNoDraft, "the job has no draft to discard")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load job draft job_id=%s", uuidToString(job.ID)))
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin job discard"))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	draft, err := lockKbDraft(ctx, qtx, db.KbDraft{WorkspaceID: job.WorkspaceID, ID: link.DraftID})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	switch draft.Status {
	case kb.DraftStatusSubmitted:
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestOpen, "the draft is under review; close the merge request instead")
		return
	case kb.DraftStatusMerged:
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestMerged, "the draft is already merged")
		return
	case kb.DraftStatusOpen:
		if _, err := qtx.SetKbDraftStatus(ctx, db.SetKbDraftStatusParams{ID: draft.ID, Status: kb.DraftStatusDiscarded}); err != nil {
			h.writeKbInternalError(w, r, errors.Wrapf(err, "discard draft draft_id=%s", uuidToString(draft.ID)))
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit job discard"))
		return
	}

	userID := requestUserID(r)
	h.publishKbJobUpdated(job, kbActorMember, userID, draft.ID)
	h.notifyKbDraftUpdated(ctx, draft, draft.Version, kbActorMember, userID)

	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, []db.KbJob{job})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, responses[0])
}

// SetKbJobArchivedRequest archives or unarchives a job.
type SetKbJobArchivedRequest struct {
	Archived bool `json:"archived"`
}

// SetKbJobArchived archives or unarchives a job (PATCH
// /api/kb/jobs/{id}/archive), as SetChatSessionArchived does a chat: the
// archived flag is the job chat's status, so the conversation turns
// read-only and the job moves behind the list's archived entry. Like a
// web-only chat, archiving leaves a running turn alone.
func (h *Handler) SetKbJobArchived(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req SetKbJobArchivedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	job, base, ok := h.loadKbJobForCreator(w, r)
	if !ok {
		return
	}

	if _, err := h.Queries.SetChatSessionArchived(ctx, db.SetChatSessionArchivedParams{ID: job.ChatSessionID, Archived: req.Archived}); err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "set job archived job_id=%s archived=%t", uuidToString(job.ID), req.Archived))
		return
	}

	h.publishKbJobUpdated(job, kbActorMember, requestUserID(r))

	responses, err := h.kbJobResponses(ctx, base.WorkspaceID, []db.KbJob{job})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, responses[0])
}

// kbDeletedJob is what deleting a job changed, for the events sent after it
// commits.
type kbDeletedJob struct {
	purged      purgedChatSession
	sessionGone bool
	// discarded is the job's draft when the delete discarded it.
	discarded *db.KbDraft
}

// DeleteKbJob hard-deletes a job with its chat (DELETE /api/kb/jobs/{id}),
// the way DeleteChatSession deletes a chat: the chat's tasks are cancelled
// and the chat is removed in the same transaction as the job. An unsubmitted
// draft is discarded as DiscardKbJob does; a submitted or merged draft stays
// with its merge requests, which only lose their link to the job. As with
// chat, the server does not require the job to be archived first; the UI
// offers delete only once it is.
func (h *Handler) DeleteKbJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	job, _, ok := h.loadKbJobForCreator(w, r)
	if !ok {
		return
	}

	deleted, err := h.deleteKbJobRows(ctx, job)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	workspaceID := uuidToString(job.WorkspaceID)
	userID := requestUserID(r)
	h.TaskService.BroadcastCancelledTasks(ctx, workspaceID, deleted.purged.cancelled, deleted.purged.reactionTargets)
	if !deleted.sessionGone {
		sessionID := uuidToString(job.ChatSessionID)
		h.publishChat(protocol.EventChatSessionDeleted, workspaceID, kbActorMember, userID, sessionID, protocol.ChatSessionDeletedPayload{
			ChatSessionID: sessionID,
		})
	}
	h.publishKbJobUpdated(job, kbActorMember, userID)
	if deleted.discarded != nil {
		h.notifyKbDraftUpdated(ctx, *deleted.discarded, deleted.discarded.Version, kbActorMember, userID)
	}

	w.WriteHeader(http.StatusNoContent)
}

// deleteKbJobRows removes a job, its chat and its draft link in one
// transaction. Locks run job, chat, agent, tasks, then draft and merge
// requests, the draft before its merge requests as merging takes them.
func (h *Handler) deleteKbJobRows(ctx context.Context, job db.KbJob) (kbDeletedJob, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kbDeletedJob{}, errors.Wrapf(err, "begin job delete job_id=%s", uuidToString(job.ID))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	// Serialises with a draft being linked to the job (linkKbJobDraft).
	if _, err := qtx.GetKbJobForUpdate(ctx, db.GetKbJobForUpdateParams{WorkspaceID: job.WorkspaceID, ID: job.ID}); err != nil {
		if isNotFound(err) {
			return kbDeletedJob{}, kbFail(http.StatusNotFound, kbCodeJobNotFound, "job not found")
		}

		return kbDeletedJob{}, errors.Wrapf(err, "lock job job_id=%s", uuidToString(job.ID))
	}

	var out kbDeletedJob
	if _, err := qtx.LockChatSessionForDelete(ctx, job.ChatSessionID); err != nil {
		if !isNotFound(err) {
			return kbDeletedJob{}, errors.Wrapf(err, "lock job chat session chat_session_id=%s", uuidToString(job.ChatSessionID))
		}
		out.sessionGone = true
	}
	if !out.sessionGone {
		session, err := qtx.GetChatSessionInWorkspace(ctx, db.GetChatSessionInWorkspaceParams{ID: job.ChatSessionID, WorkspaceID: job.WorkspaceID})
		if err != nil {
			return kbDeletedJob{}, errors.Wrapf(err, "load job chat session chat_session_id=%s", uuidToString(job.ChatSessionID))
		}
		if out.purged, err = purgeChatSession(ctx, qtx, session); err != nil {
			return kbDeletedJob{}, errors.Wrapf(err, "delete job chat session chat_session_id=%s", uuidToString(session.ID))
		}
	}

	link, err := qtx.GetKbJobDraftByJob(ctx, job.ID)
	switch {
	case err == nil:
		draft, err := lockKbDraft(ctx, qtx, db.KbDraft{WorkspaceID: job.WorkspaceID, ID: link.DraftID})
		if err != nil {
			return kbDeletedJob{}, err
		}
		if draft.Status == kb.DraftStatusOpen {
			if _, err := qtx.SetKbDraftStatus(ctx, db.SetKbDraftStatusParams{ID: draft.ID, Status: kb.DraftStatusDiscarded}); err != nil {
				return kbDeletedJob{}, errors.Wrapf(err, "discard draft draft_id=%s", uuidToString(draft.ID))
			}
			out.discarded = &draft
		}
	case !isNotFound(err):
		return kbDeletedJob{}, errors.Wrapf(err, "load job draft job_id=%s", uuidToString(job.ID))
	}

	if err := qtx.DeleteKbJobDraftByJob(ctx, db.DeleteKbJobDraftByJobParams{WorkspaceID: job.WorkspaceID, JobID: job.ID}); err != nil {
		return kbDeletedJob{}, errors.Wrapf(err, "unlink job draft job_id=%s", uuidToString(job.ID))
	}
	if err := qtx.ClearKbMergeRequestJob(ctx, db.ClearKbMergeRequestJobParams{WorkspaceID: job.WorkspaceID, JobID: job.ID}); err != nil {
		return kbDeletedJob{}, errors.Wrapf(err, "detach job merge requests job_id=%s", uuidToString(job.ID))
	}
	if err := qtx.DeleteKbJob(ctx, db.DeleteKbJobParams{WorkspaceID: job.WorkspaceID, ID: job.ID}); err != nil {
		return kbDeletedJob{}, errors.Wrapf(err, "delete job job_id=%s", uuidToString(job.ID))
	}

	if err := tx.Commit(ctx); err != nil {
		return kbDeletedJob{}, errors.Wrapf(err, "commit job delete job_id=%s", uuidToString(job.ID))
	}

	return out, nil
}

// CreateKbMergeRequest opens a merge request for a draft the caller may
// write (POST /api/kb/merge-requests; kb mr create). A draft linked to a job
// counts as that job's submit: the job page turns read-only.
func (h *Handler) CreateKbMergeRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbMergeRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidMergeRequest, "title is required")
		return
	}
	if req.Source != "" && (!kb.IsMergeRequestSource(req.Source) || req.Source == kb.MergeRequestSourceRevert) {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidMergeRequest, "source is not a known merge request source")
		return
	}
	risk := req.Risk
	if risk == "" {
		risk = kb.MergeRequestRiskLow
	}
	if !kb.IsMergeRequestRisk(risk) {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidMergeRequest, "risk must be low, medium or high")
		return
	}
	annotationIDs, ok := parseUUIDSliceOrBadRequest(w, req.AnnotationIDs, "annotation_ids")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}
	draftID, ok := parseUUIDOrBadRequest(w, req.DraftID, "draft_id")
	if !ok {
		return
	}

	draft, err := h.Queries.GetKbDraftInWorkspace(ctx, db.GetKbDraftInWorkspaceParams{WorkspaceID: wsUUID, ID: draftID})
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeDraftNotFound, "draft not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load draft draft_id=%s", req.DraftID))
		return
	}
	if uuidToString(draft.CreatedBy) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeForbidden, "only the draft creator can submit it")
		return
	}
	base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: draft.KnowledgeBaseID})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of draft draft_id=%s", req.DraftID))
		return
	}

	var job *db.KbJob
	linked, err := h.Queries.GetKbJobByDraft(ctx, draft.ID)
	switch {
	case err == nil:
		job = &linked
	case !isNotFound(err):
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load job of draft draft_id=%s", req.DraftID))
		return
	}

	source := req.Source
	if source == "" {
		source = kb.MergeRequestSourceCustom
		if job != nil {
			source = kb.StarterSource(job.Starter)
		}
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(wsUUID))

	created, locked, err := h.openKbMergeRequest(ctx, base, draft.ID, kbOpenMergeRequest{
		title:         title,
		summary:       strings.TrimSpace(req.Summary),
		source:        source,
		risk:          risk,
		authorType:    actorType,
		authorID:      parseUUID(actorID),
		job:           job,
		annotationIDs: annotationIDs,
	})
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestCreated(created, locked, job, actorType, actorID)

	resp, err := h.kbMergeRequestResponseOf(ctx, created.MergeRequest)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

// kbOpenMergeRequest is what a merge request is opened with.
type kbOpenMergeRequest struct {
	title, summary, source, risk string
	authorType                   string
	authorID                     pgtype.UUID
	job                          *db.KbJob
	annotationIDs                []pgtype.UUID
}

// openKbMergeRequest checks a draft can be submitted and opens its merge
// request in one transaction: the draft must be open with changes, no format
// check may report an error, and it must have no open merge request.
// Conflicts with the mainline do not block; review handles them.
func (h *Handler) openKbMergeRequest(ctx context.Context, base db.KbBase, draftID pgtype.UUID, in kbOpenMergeRequest) (kb.CreatedMergeRequest, db.KbDraft, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrap(err, "begin merge request create")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	draft, err := lockKbDraft(ctx, qtx, db.KbDraft{WorkspaceID: base.WorkspaceID, ID: draftID})
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}
	if _, err := qtx.GetOpenKbMergeRequestByDraft(ctx, db.GetOpenKbMergeRequestByDraftParams{DraftID: draft.ID, Statuses: kbActiveMergeRequestStatuses}); err == nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, kbFail(http.StatusConflict, kbCodeMergeRequestOpen, "the draft already has an open merge request")
	} else if !isNotFound(err) {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrapf(err, "load open merge request draft_id=%s", uuidToString(draft.ID))
	}
	if draft.Status != kb.DraftStatusOpen {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, kbFail(http.StatusConflict, kbCodeDraftNotOpen, "the draft is "+draft.Status+" and cannot be submitted")
	}

	overlay, err := loadKbOverlay(ctx, qtx, base.ID, draft.ID)
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}
	if len(overlay.rows) == 0 {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, kbFail(http.StatusConflict, kbCodeDraftEmpty, "the draft changes nothing")
	}
	findings, err := lintKbDraftPages(ctx, qtx, base, overlay, nil)
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}
	for _, f := range findings {
		if f.Severity == lint.SeverityError {
			return kb.CreatedMergeRequest{}, db.KbDraft{}, kbFail(http.StatusConflict, kbCodeDraftCheckFailed, "the draft check reports errors; fix them before submitting")
		}
	}

	var jobID pgtype.UUID
	if in.job != nil {
		jobID = in.job.ID
	}
	created, err := kb.CreateMergeRequest(ctx, qtx, kb.NewMergeRequest{
		Draft:         draft,
		JobID:         jobID,
		Title:         in.title,
		Summary:       in.summary,
		Source:        in.source,
		Risk:          in.risk,
		AuthorType:    in.authorType,
		AuthorID:      in.authorID,
		AnnotationIDs: in.annotationIDs,
	})
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrap(err, "commit merge request create")
	}

	return created, draft, nil
}

func (h *Handler) publishKbMergeRequestCreated(created kb.CreatedMergeRequest, draft db.KbDraft, job *db.KbJob, actorType, actorID string) {
	mr := created.MergeRequest
	workspaceID := uuidToString(mr.WorkspaceID)
	var jobID any
	if job != nil {
		jobID = uuidToString(job.ID)
	}

	h.publish(protocol.EventKbMrCreated, workspaceID, actorType, actorID, map[string]any{
		"merge_request_id":  uuidToString(mr.ID),
		"number":            mr.Number,
		"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
		"draft_id":          uuidToString(draft.ID),
		"job_id":            jobID,
	})
	if job != nil {
		h.publishKbJobUpdated(*job, actorType, actorID, draft.ID)
	}
	if len(created.Annotations) > 0 {
		ids := make([]string, len(created.Annotations))
		for i, id := range created.Annotations {
			ids[i] = uuidToString(id)
		}
		h.publish(protocol.EventKbAnnotationChanged, workspaceID, actorType, actorID, map[string]any{
			"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
			"annotation_ids":    ids,
			"page_ids":          []string{},
		})
	}
}
