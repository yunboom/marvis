package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Diff line kinds of the draft view (GET /api/kb/drafts/{id}).
const (
	kbDiffContext = "context"
	kbDiffAdd     = "add"
	kbDiffDelete  = "delete"
)

// Results of kb draft sync per page.
const (
	kbSyncMerged   = "merged"
	kbSyncConflict = "conflict"
)

var kbDiffKinds = map[string]string{
	kb.DiffEqual:   kbDiffContext,
	kb.DiffAdded:   kbDiffAdd,
	kb.DiffDeleted: kbDiffDelete,
}

// CreateKbDraftRequest starts a draft. JobID links it to a knowledge base
// job in the same transaction.
type CreateKbDraftRequest struct {
	KnowledgeBase string  `json:"knowledge_base"`
	Title         string  `json:"title"`
	JobID         *string `json:"job_id"`
}

// KbDraftResponse is a created draft. The task that created it is recorded
// but not returned.
type KbDraftResponse struct {
	ID              string `json:"id"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	Title           string `json:"title"`
	Version         int64  `json:"version"`
	Status          string `json:"status"`
}

// KbDraftDiffLine is one line of a changed page's diff.
type KbDraftDiffLine struct {
	Kind    string `json:"kind"`
	Text    string `json:"text"`
	BlockID string `json:"block_id"`
	OldLine int    `json:"old_line"`
	NewLine int    `json:"new_line"`
}

// KbDraftPageChangeResponse is one changed page of a draft, a file card of a
// merge request.
type KbDraftPageChangeResponse struct {
	PageID  string            `json:"page_id"`
	Path    string            `json:"path"`
	OldPath string            `json:"old_path"`
	Title   string            `json:"title"`
	Change  string            `json:"change"`
	Added   int               `json:"added"`
	Deleted int               `json:"deleted"`
	Lines   []KbDraftDiffLine `json:"lines"`
}

// KbDraftConflictResponse is an unresolved conflict with the mainline.
type KbDraftConflictResponse struct {
	PageID     string `json:"page_id"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	BlockID    string `json:"block_id"`
	Key        string `json:"key"`
	MainLines  string `json:"main_lines"`
	DraftLines string `json:"draft_lines"`
}

// KbDraftChecksResponse is what kb draft check reports.
type KbDraftChecksResponse struct {
	Lint      []lint.Finding            `json:"lint"`
	Conflicts []KbDraftConflictResponse `json:"conflicts"`
}

// KbDraftDetailResponse is a draft's changes and checks (GET
// /api/kb/drafts/{id}).
type KbDraftDetailResponse struct {
	ID              string                      `json:"id"`
	KnowledgeBaseID string                      `json:"knowledge_base_id"`
	Title           string                      `json:"title"`
	Version         int64                       `json:"version"`
	Status          string                      `json:"status"`
	Pages           []KbDraftPageChangeResponse `json:"pages"`
	Checks          KbDraftChecksResponse       `json:"checks"`
}

// KbSyncPageResponse is one draft page the mainline changed since its base.
type KbSyncPageResponse struct {
	PageID    string        `json:"page_id"`
	Path      string        `json:"path"`
	Result    string        `json:"result"`
	Conflicts []kb.Conflict `json:"conflicts"`
}

// KbSyncResponse is the result of merging the mainline into a draft.
type KbSyncResponse struct {
	Version    int64                `json:"version"`
	Pages      []KbSyncPageResponse `json:"pages"`
	Unresolved int                  `json:"unresolved"`
}

// CreateKbDraft starts a draft (POST /api/kb/drafts). Called with a task
// token it records the task in kb_draft.task_id; with job_id it links the
// draft to that knowledge base job.
func (h *Handler) CreateKbDraft(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.KnowledgeBase) == "" {
		writeError(w, http.StatusBadRequest, "knowledge_base is required")
		return
	}
	base, ok := h.loadKbBaseForUser(w, r, req.KnowledgeBase)
	if !ok {
		return
	}

	var jobID pgtype.UUID
	if req.JobID != nil && *req.JobID != "" {
		if jobID, ok = parseUUIDOrBadRequest(w, *req.JobID, "job_id"); !ok {
			return
		}
	}

	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	var task *db.AgentTaskQueue
	if actorType == kbActorAgent {
		if t, found := h.taskFromRequestHeader(r); found {
			task = &t
		}
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin draft create"))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	var taskID pgtype.UUID
	if task != nil {
		taskID = task.ID
	}
	draft, err := qtx.CreateKbDraft(ctx, db.CreateKbDraftParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Title:           strings.TrimSpace(req.Title),
		CreatedBy:       parseUUID(userID),
		TaskID:          taskID,
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create draft knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	var job *db.KbJob
	if jobID.Valid {
		linked, err := linkKbJobDraft(ctx, qtx, base, draft, jobID, userID, actorType, actorID, task)
		if err != nil {
			h.writeKbError(w, r, err)
			return
		}
		job = &linked
	}

	if err := tx.Commit(ctx); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit draft create"))
		return
	}

	if job != nil {
		h.publish(protocol.EventKbJobUpdated, uuidToString(base.WorkspaceID), actorType, actorID, map[string]any{
			"job_id":            uuidToString(job.ID),
			"knowledge_base_id": uuidToString(base.ID),
			"draft_id":          uuidToString(draft.ID),
		})
	}

	writeJSON(w, http.StatusCreated, KbDraftResponse{
		ID:              uuidToString(draft.ID),
		KnowledgeBaseID: uuidToString(draft.KnowledgeBaseID),
		Title:           draft.Title,
		Version:         draft.Version,
		Status:          draft.Status,
	})
}

// linkKbJobDraft links a new draft to a job: the job must be of the same
// knowledge base, the caller its creator or the agent running in its chat,
// and the job must not have a draft yet.
func linkKbJobDraft(ctx context.Context, q *db.Queries, base db.KbBase, draft db.KbDraft, jobID pgtype.UUID, userID, actorType, actorID string, task *db.AgentTaskQueue) (db.KbJob, error) {
	job, err := q.GetKbJobForUpdate(ctx, db.GetKbJobForUpdateParams{WorkspaceID: base.WorkspaceID, ID: jobID})
	if err != nil {
		if isNotFound(err) {
			return db.KbJob{}, kbFail(http.StatusNotFound, kbCodeJobNotFound, "job not found")
		}

		return db.KbJob{}, errors.Wrapf(err, "load job job_id=%s", uuidToString(jobID))
	}
	if job.KnowledgeBaseID != base.ID {
		return db.KbJob{}, kbFail(http.StatusNotFound, kbCodeJobNotFound, "job not found in this knowledge base")
	}

	runsInJob := actorType == kbActorAgent && task != nil &&
		actorID == uuidToString(job.AgentID) && task.ChatSessionID == job.ChatSessionID
	if uuidToString(job.CreatedBy) != userID && !runsInJob {
		return db.KbJob{}, kbFail(http.StatusForbidden, kbCodeForbidden, "only the job creator or the agent running the job can link its draft")
	}

	existing, err := q.GetKbJobDraftByJob(ctx, job.ID)
	switch {
	case err == nil:
		return db.KbJob{}, &kbRequestError{
			status:  http.StatusConflict,
			code:    kbCodeJobDraftExists,
			message: "the job already has a draft",
			extra:   map[string]any{"draft_id": uuidToString(existing.DraftID)},
		}
	case !isNotFound(err):
		return db.KbJob{}, errors.Wrapf(err, "load job draft job_id=%s", uuidToString(job.ID))
	}

	if _, err := q.CreateKbJobDraft(ctx, db.CreateKbJobDraftParams{
		WorkspaceID: base.WorkspaceID,
		JobID:       job.ID,
		DraftID:     draft.ID,
		CreatedBy:   parseUUID(userID),
	}); err != nil {
		return db.KbJob{}, errors.Wrapf(err, "link draft job_id=%s draft_id=%s", uuidToString(job.ID), uuidToString(draft.ID))
	}

	return job, nil
}

// loadKbDraftForWriter loads a draft and the knowledge base it belongs to;
// only the draft creator may write it.
func (h *Handler) loadKbDraftForWriter(w http.ResponseWriter, r *http.Request) (db.KbDraft, db.KbBase, bool) {
	draft, base, ok := h.loadKbDraftWithBase(w, r)
	if !ok {
		return db.KbDraft{}, db.KbBase{}, false
	}
	if uuidToString(draft.CreatedBy) != requestUserID(r) {
		writeError(w, http.StatusForbidden, "only the draft creator can write it")
		return db.KbDraft{}, db.KbBase{}, false
	}

	return draft, base, true
}

// loadKbDraftWithBase loads a draft the caller may read and the knowledge
// base it belongs to.
func (h *Handler) loadKbDraftWithBase(w http.ResponseWriter, r *http.Request) (db.KbDraft, db.KbBase, bool) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbDraft{}, db.KbBase{}, false
	}
	draft, ok := h.loadKbDraftForReader(w, r, wsUUID, chi.URLParam(r, "draftId"))
	if !ok {
		return db.KbDraft{}, db.KbBase{}, false
	}

	base, err := h.Queries.GetKbBaseByID(r.Context(), db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: draft.KnowledgeBaseID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "draft not found")
			return db.KbDraft{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of draft draft_id=%s", uuidToString(draft.ID)))
		return db.KbDraft{}, db.KbBase{}, false
	}

	return draft, base, true
}

// GetKbDraft returns a draft's changed pages as line diffs and its checks
// (GET /api/kb/drafts/{id}; kb draft check).
func (h *Handler) GetKbDraft(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	draft, base, ok := h.loadKbDraftWithBase(w, r)
	if !ok {
		return
	}

	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, draft.ID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	pages, err := h.kbDraftChanges(ctx, base, overlay)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	findings, err := lintKbDraftPages(ctx, h.Queries, base, overlay, nil)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, KbDraftDetailResponse{
		ID:              uuidToString(draft.ID),
		KnowledgeBaseID: uuidToString(draft.KnowledgeBaseID),
		Title:           draft.Title,
		Version:         draft.Version,
		Status:          draft.Status,
		Pages:           pages,
		Checks: KbDraftChecksResponse{
			Lint:      findings,
			Conflicts: kbDraftConflicts(overlay),
		},
	})
}

// kbDraftChanges diffs every draft page against the revision it is based
// on, both rendered as Markdown with links as paths.
func (h *Handler) kbDraftChanges(ctx context.Context, base db.KbBase, overlay kbOverlay) ([]KbDraftPageChangeResponse, error) {
	mainTree, err := loadKbTreeWith(ctx, h.Queries, base.ID, nil)
	if err != nil {
		return nil, err
	}

	revisionIDs := make([]pgtype.UUID, 0, len(overlay.rows))
	for _, page := range overlay.rows {
		if page.baseRevision.Valid {
			revisionIDs = append(revisionIDs, page.baseRevision)
		}
	}
	revisions, err := h.Queries.ListKbPageRevisionsByIDs(ctx, db.ListKbPageRevisionsByIDsParams{KnowledgeBaseID: base.ID, Ids: revisionIDs})
	if err != nil {
		return nil, errors.Wrapf(err, "list base revisions knowledge_base_id=%s", uuidToString(base.ID))
	}
	baseBlocks := make(map[string][]kb.Block, len(revisions))
	for _, rev := range revisions {
		if rev.Deleted {
			baseBlocks[uuidToString(rev.ID)] = nil
			continue
		}
		blocks, err := kb.ParseBlocks(rev.Blocks)
		if err != nil {
			return nil, errors.Wrapf(err, "revision_id=%s", uuidToString(rev.ID))
		}
		baseBlocks[uuidToString(rev.ID)] = kb.PathLinks(blocks, mainTree)
	}

	out := make([]KbDraftPageChangeResponse, 0, len(overlay.order))
	for _, id := range overlay.order {
		page := overlay.rows[id]
		before := baseBlocks[uuidToString(page.baseRevision)]
		var after []kb.Block
		if page.op != kb.DraftOpDelete {
			after = kb.PathLinks(page.blocks, overlay.tree)
		}

		diff := kb.LineDiff(kb.SplitLines(kb.JoinBlocks(before)), kb.SplitLines(kb.JoinBlocks(after)))
		stats := kb.Stats(diff)
		beforeLines := kb.BlockOfLines(before)
		afterLines := kb.BlockOfLines(after)
		lines := make([]KbDraftDiffLine, len(diff))
		for i, line := range diff {
			blockID := ""
			switch {
			case line.NewLine > 0 && line.NewLine <= len(afterLines):
				blockID = afterLines[line.NewLine-1]
			case line.OldLine > 0 && line.OldLine <= len(beforeLines):
				blockID = beforeLines[line.OldLine-1]
			}
			lines[i] = KbDraftDiffLine{Kind: kbDiffKinds[line.Op], Text: line.Text, BlockID: blockID, OldLine: line.OldLine, NewLine: line.NewLine}
		}

		path, _ := overlay.tree.PathByPageID(id)
		oldPath, onMainline := mainTree.PathByPageID(id)
		if path == "" {
			path = oldPath
		}
		change := kb.DraftChange(page.op)
		switch {
		case page.op == kb.DraftOpCreate || page.op == kb.DraftOpDelete:
			oldPath = ""
		case onMainline && oldPath != path && stats.Added == 0 && stats.Deleted == 0:
			change = kb.DraftChangeMoved
		case onMainline && oldPath != path:
			change = kb.DraftChangeModified
		default:
			change = kb.DraftChangeModified
			oldPath = ""
		}

		title, _ := page.header[kb.MetaTitle].(string)
		out = append(out, KbDraftPageChangeResponse{
			PageID:  id,
			Path:    path,
			OldPath: oldPath,
			Title:   title,
			Change:  change,
			Added:   stats.Added,
			Deleted: stats.Deleted,
			Lines:   lines,
		})
	}

	return out, nil
}

func kbDraftConflicts(overlay kbOverlay) []KbDraftConflictResponse {
	out := make([]KbDraftConflictResponse, 0)
	for _, id := range overlay.order {
		page := overlay.rows[id]
		path, _ := overlay.tree.PathByPageID(id)
		for _, c := range page.conflicts {
			out = append(out, KbDraftConflictResponse{
				PageID:     id,
				Path:       path,
				Kind:       c.Kind,
				BlockID:    c.BlockID,
				Key:        c.Key,
				MainLines:  c.MainLines,
				DraftLines: c.DraftLines,
			})
		}
	}

	return out
}

// SyncKbDraft merges the mainline's changes into a draft, like git merge
// main (POST /api/kb/drafts/{id}/sync): each draft page whose mainline page
// moved on is merged three ways and rebased onto the mainline head.
// Conflicts are written into the draft for the agent to resolve.
func (h *Handler) SyncKbDraft(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	unlocked, base, ok := h.loadKbDraftForWriter(w, r)
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin draft sync"))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	draft, err := lockKbOpenDraft(ctx, qtx, unlocked)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	resp, err := syncKbDraft(ctx, qtx, base, draft)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit draft sync"))
		return
	}
	if len(resp.Pages) > 0 {
		pageIDs := make([]string, len(resp.Pages))
		for i, page := range resp.Pages {
			pageIDs[i] = page.PageID
		}
		h.notifyKbDraftWrite(r, draft, kbDraftVersion(resp.Version), pageIDs...)
	}

	writeJSON(w, http.StatusOK, resp)
}

// lockKbOpenDraft locks the draft row for a write and checks it still takes
// writes: an open draft, or one under review, which the agent keeps changing
// to answer review comments (spec 08.6); the merge request's diff follows.
func lockKbOpenDraft(ctx context.Context, q *db.Queries, draft db.KbDraft) (db.KbDraft, error) {
	locked, err := lockKbDraft(ctx, q, draft)
	if err != nil {
		return db.KbDraft{}, err
	}
	if !slices.Contains(liveDraftStatuses, locked.Status) {
		return db.KbDraft{}, kbFail(http.StatusConflict, kbCodeDraftNotOpen, "the draft is "+locked.Status+" and takes no more writes")
	}

	return locked, nil
}

// lockKbDraft locks the draft row whatever its status.
func lockKbDraft(ctx context.Context, q *db.Queries, draft db.KbDraft) (db.KbDraft, error) {
	locked, err := q.GetKbDraftForUpdate(ctx, db.GetKbDraftForUpdateParams{WorkspaceID: draft.WorkspaceID, ID: draft.ID})
	if err != nil {
		return db.KbDraft{}, errors.Wrapf(err, "lock draft draft_id=%s", uuidToString(draft.ID))
	}

	return locked, nil
}

func syncKbDraft(ctx context.Context, q *db.Queries, base db.KbBase, draft db.KbDraft) (KbSyncResponse, error) {
	overlay, err := loadKbOverlay(ctx, q, base.ID, draft.ID)
	if err != nil {
		return KbSyncResponse{}, err
	}

	pageIDs := make([]pgtype.UUID, 0, len(overlay.rows))
	for _, page := range overlay.rows {
		if page.baseRevision.Valid {
			pageIDs = append(pageIDs, parseUUID(page.pageID))
		}
	}
	mainPages, err := q.ListKbPagesByIDs(ctx, db.ListKbPagesByIDsParams{KnowledgeBaseID: base.ID, Ids: pageIDs})
	if err != nil {
		return KbSyncResponse{}, errors.Wrapf(err, "list mainline pages draft_id=%s", uuidToString(draft.ID))
	}

	heads := make(map[string]pgtype.UUID, len(mainPages))
	revisionIDs := make([]pgtype.UUID, 0, 2*len(mainPages))
	for _, page := range mainPages {
		id := uuidToString(page.ID)
		state := overlay.rows[id]
		if page.HeadRevisionID == state.baseRevision {
			continue
		}
		heads[id] = page.HeadRevisionID
		revisionIDs = append(revisionIDs, page.HeadRevisionID, state.baseRevision)
	}

	resp := KbSyncResponse{Version: draft.Version, Pages: []KbSyncPageResponse{}}
	if len(heads) > 0 {
		revisions, err := q.ListKbPageRevisionsByIDs(ctx, db.ListKbPageRevisionsByIDsParams{KnowledgeBaseID: base.ID, Ids: revisionIDs})
		if err != nil {
			return KbSyncResponse{}, errors.Wrapf(err, "list revisions draft_id=%s", uuidToString(draft.ID))
		}
		byID := make(map[string]db.KbPageRevision, len(revisions))
		for _, rev := range revisions {
			byID[uuidToString(rev.ID)] = rev
		}

		merged, err := mergeKbDraftPages(&overlay, heads, byID)
		if err != nil {
			return KbSyncResponse{}, err
		}

		for _, page := range merged {
			version, err := saveKbDraftPage(ctx, q, draft, page)
			if err != nil {
				return KbSyncResponse{}, err
			}
			resp.Version = version
			draft.Version = version
		}

		for _, page := range merged {
			path, _ := overlay.tree.PathByPageID(page.pageID)
			result := kbSyncMerged
			if len(page.conflicts) > 0 {
				result = kbSyncConflict
			}
			resp.Pages = append(resp.Pages, KbSyncPageResponse{PageID: page.pageID, Path: path, Result: result, Conflicts: page.conflicts})
		}
	}

	for _, page := range overlay.rows {
		resp.Unresolved += len(page.conflicts)
	}

	return resp, nil
}

// mergeKbDraftPages three-way merges each draft page whose mainline head
// moved, places the results in the overlay and flags slugs that now clash
// with a sibling. It returns the merged pages in page id order.
func mergeKbDraftPages(overlay *kbOverlay, heads map[string]pgtype.UUID, revisions map[string]db.KbPageRevision) ([]*kbDraftPage, error) {
	ids := make([]string, 0, len(heads))
	for id := range heads {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	merged := make([]*kbDraftPage, 0, len(ids))
	for _, id := range ids {
		state := overlay.rows[id]
		baseRev, okBase := revisions[uuidToString(state.baseRevision)]
		headRev, okHead := revisions[uuidToString(heads[id])]
		if !okBase || !okHead {
			return nil, errors.Errorf("missing revision for page_id=%s", id)
		}

		baseVersion, err := kbRevisionVersion(baseRev)
		if err != nil {
			return nil, err
		}
		mainVersion, err := kbRevisionVersion(headRev)
		if err != nil {
			return nil, err
		}
		draftVersion := kb.PageVersion{
			ParentID:    state.parentID,
			Position:    state.position,
			Slug:        state.slug,
			Frontmatter: state.header,
			Blocks:      state.blocks,
			Claims:      state.claims,
			Deleted:     state.op == kb.DraftOpDelete,
		}

		result := kb.MergePage(baseVersion, mainVersion, draftVersion)

		page := state
		page.baseRevision = heads[id]
		page.parentID = result.Page.ParentID
		page.position = result.Page.Position
		page.slug = result.Page.Slug
		page.header = result.Page.Frontmatter
		page.blocks = result.Page.Blocks
		page.claims = result.Page.Claims
		page.conflicts = mergeKbConflicts(state.conflicts, result.Conflicts)
		switch {
		case result.Page.Deleted:
			page.op = kb.DraftOpDelete
		case state.op == kb.DraftOpDelete || state.op == kb.DraftOpMove && !jsonEqualBlocks(state.blocks, page.blocks):
			page.op = kb.DraftOpUpdate
		}
		if page.op != kb.DraftOpDelete {
			page.header[kb.MetaSources] = kbSourcesHeader(page.blocks, page.claims)
		}
		overlay.place(page)
		merged = append(merged, &page)
	}

	for _, page := range merged {
		if page.op == kb.DraftOpDelete || !overlay.slugTaken(page.parentID, page.slug, page.pageID) {
			continue
		}
		page.conflicts = mergeKbConflicts(page.conflicts, []kb.Conflict{{Kind: kb.ConflictMove}})
		overlay.place(*page)
	}

	return merged, nil
}

func kbRevisionVersion(rev db.KbPageRevision) (kb.PageVersion, error) {
	id := uuidToString(rev.ID)
	header, _, err := kb.ParseFrontmatter(rev.Frontmatter)
	if err != nil {
		return kb.PageVersion{}, errors.Wrapf(err, "revision_id=%s", id)
	}
	blocks, err := kb.ParseBlocks(rev.Blocks)
	if err != nil {
		return kb.PageVersion{}, errors.Wrapf(err, "revision_id=%s", id)
	}
	claims, err := kb.ParseClaims(rev.Claims)
	if err != nil {
		return kb.PageVersion{}, errors.Wrapf(err, "revision_id=%s", id)
	}

	return kb.PageVersion{
		ParentID:    uuidOrEmpty(rev.ParentID),
		Position:    rev.Position,
		Slug:        rev.Slug,
		Frontmatter: header,
		Blocks:      blocks,
		Claims:      claims,
		Deleted:     rev.Deleted,
	}, nil
}

// mergeKbConflicts keeps the conflicts a page still has and adds new ones,
// one entry per block, header key or kind.
func mergeKbConflicts(existing, added []kb.Conflict) []kb.Conflict {
	out := make([]kb.Conflict, 0, len(existing)+len(added))
	seen := make(map[string]bool)
	for _, list := range [][]kb.Conflict{added, existing} {
		for _, c := range list {
			key := c.Kind + "\x00" + c.BlockID + "\x00" + c.Key
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, c)
		}
	}

	return out
}

func jsonEqualBlocks(a, b []kb.Block) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}

	return true
}
