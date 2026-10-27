package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Error codes of merge, close and revert.
const (
	kbCodeMergeRequestNotOpen   = "merge_request_not_open"
	kbCodeMergeRequestNotMerged = "merge_request_not_merged"
	kbCodeMergeRequestNotFound  = "merge_request_not_found"
	kbCodeStaleDraftVersion     = "stale_draft_version"
	kbCodeMergeConflict         = "merge_conflict"
	kbCodeUnresolvedConflict    = "unresolved_conflict"
	kbCodeRevertConflict        = "revert_conflict"
	kbCodeNothingToRevert       = "nothing_to_revert"
)

// MergeKbMergeRequestRequest merges a merge request (POST
// /api/kb/merge-requests/{number}/merge).
type MergeKbMergeRequestRequest struct {
	// DraftVersion is the draft version the reviewer saw; merging refuses a
	// draft that changed since.
	DraftVersion *int64 `json:"draft_version"`
}

// CloseKbMergeRequestRequest closes a merge request without merging.
type CloseKbMergeRequestRequest struct {
	Reason string `json:"reason"`
}

// kbMergePage is one page of a merge plan.
type kbMergePage struct {
	pageID string
	// prev is the mainline head the page moves on from; invalid for a page
	// the draft creates.
	prev pgtype.UUID
	// onMainline is set when the page exists on the mainline (live or
	// deleted), so its annotations follow the new body.
	onMainline bool
	page       kb.PageVersion
}

// kbMergePlan is the result of merging a draft over the current mainline,
// before anything is written.
type kbMergePlan struct {
	pages     []kbMergePage
	conflicts []KbDraftConflictResponse
	tree      *kb.PageTree
}

// planKbMerge merges each draft page over the mainline page it is based on
// (spec 6.3): a page the mainline did not touch since is taken from the
// draft as is, otherwise base, mainline and draft are merged three ways.
// Conflicts the draft still has, conflicts of the merge and slugs that clash
// with a sibling all end up in conflicts. mainPages are the mainline rows of
// the draft's pages, locked by the caller when the plan will be written.
func planKbMerge(ctx context.Context, q *db.Queries, base db.KbBase, overlay kbOverlay, mainPages []db.KbPage) (kbMergePlan, error) {
	mainByID := make(map[string]db.KbPage, len(mainPages))
	revisionIDs := make([]pgtype.UUID, 0, 2*len(mainPages))
	for _, page := range mainPages {
		id := uuidToString(page.ID)
		mainByID[id] = page
		state, ok := overlay.rows[id]
		if ok && state.baseRevision.Valid && page.HeadRevisionID != state.baseRevision {
			revisionIDs = append(revisionIDs, page.HeadRevisionID, state.baseRevision)
		}
	}

	revisions := map[string]db.KbPageRevision{}
	if len(revisionIDs) > 0 {
		rows, err := q.ListKbPageRevisionsByIDs(ctx, db.ListKbPageRevisionsByIDsParams{KnowledgeBaseID: base.ID, Ids: revisionIDs})
		if err != nil {
			return kbMergePlan{}, errors.Wrapf(err, "list merge revisions knowledge_base_id=%s", uuidToString(base.ID))
		}
		for _, rev := range rows {
			revisions[uuidToString(rev.ID)] = rev
		}
	}

	plan := kbMergePlan{conflicts: kbDraftConflicts(overlay)}
	conflicted := make(map[string]bool)
	for _, c := range plan.conflicts {
		conflicted[c.PageID] = true
	}

	ids := slicesSorted(overlay.order)
	for _, id := range ids {
		state := overlay.rows[id]
		draft := kbDraftPageVersion(state)
		main, onMainline := mainByID[id]

		entry := kbMergePage{pageID: id, onMainline: onMainline, page: draft}
		if onMainline {
			entry.prev = main.HeadRevisionID
		}
		if onMainline && state.baseRevision.Valid && main.HeadRevisionID != state.baseRevision {
			baseRev, okBase := revisions[uuidToString(state.baseRevision)]
			headRev, okHead := revisions[uuidToString(main.HeadRevisionID)]
			if !okBase || !okHead {
				return kbMergePlan{}, errors.Errorf("missing revision for page_id=%s", id)
			}
			baseVersion, err := kbRevisionVersion(baseRev)
			if err != nil {
				return kbMergePlan{}, err
			}
			mainVersion, err := kbRevisionVersion(headRev)
			if err != nil {
				return kbMergePlan{}, err
			}

			result := kb.MergePage(baseVersion, mainVersion, draft)
			entry.page = result.Page
			if !entry.page.Deleted {
				entry.page.Frontmatter[kb.MetaSources] = kbSourcesHeader(entry.page.Blocks, entry.page.Claims)
			}
			if len(result.Conflicts) > 0 && !conflicted[id] {
				plan.conflicts = append(plan.conflicts, kbConflictResponses(id, overlay, result.Conflicts)...)
				conflicted[id] = true
			}
		}
		plan.pages = append(plan.pages, entry)
	}

	tree, clashes, err := kbMergedTree(ctx, q, base, plan.pages)
	if err != nil {
		return kbMergePlan{}, err
	}
	plan.tree = tree
	for _, c := range clashes {
		if conflicted[c.pageID] {
			continue
		}
		path, _ := overlay.tree.PathByPageID(c.pageID)
		plan.conflicts = append(plan.conflicts, KbDraftConflictResponse{PageID: c.pageID, Path: path, Kind: c.kind})
		conflicted[c.pageID] = true
	}

	return plan, nil
}

// kbTreeClash is a merged page that cannot take its place in the tree.
type kbTreeClash struct {
	pageID string
	kind   string
}

// kbMergedTree lays the merged pages over the mainline tree and reports the
// merged pages that cannot take their place: a slug that clashes with a live
// sibling or a parent that is gone (move), and a deleted page that still has
// live children (page). Either would leave a page outside the tree.
func kbMergedTree(ctx context.Context, q *db.Queries, base db.KbBase, pages []kbMergePage) (*kb.PageTree, []kbTreeClash, error) {
	rows, err := q.ListKbPageTree(ctx, base.ID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list page tree knowledge_base_id=%s", uuidToString(base.ID))
	}

	nodes := make(map[string]kb.TreeNode, len(rows)+len(pages))
	for _, row := range rows {
		id := uuidToString(row.ID)
		nodes[id] = kb.TreeNode{ID: id, ParentID: uuidOrEmpty(row.ParentID), Slug: row.Slug, Title: row.Title, Position: row.Position}
	}
	for _, p := range pages {
		if p.page.Deleted {
			delete(nodes, p.pageID)
			continue
		}
		title, _ := p.page.Frontmatter[kb.MetaTitle].(string)
		nodes[p.pageID] = kb.TreeNode{ID: p.pageID, ParentID: p.page.ParentID, Slug: p.page.Slug, Title: title, Position: p.page.Position}
	}

	bySibling := make(map[string][]string)
	hasChildren := make(map[string]bool)
	for id, node := range nodes {
		key := node.ParentID + "\x00" + node.Slug
		bySibling[key] = append(bySibling[key], id)
		if node.ParentID != "" {
			hasChildren[node.ParentID] = true
		}
	}
	clashes := make([]kbTreeClash, 0)
	for _, p := range pages {
		if p.page.Deleted {
			if hasChildren[p.pageID] {
				clashes = append(clashes, kbTreeClash{pageID: p.pageID, kind: kb.ConflictPage})
			}
			continue
		}
		_, parentLive := nodes[p.page.ParentID]
		orphaned := p.page.ParentID != "" && !parentLive
		if orphaned || len(bySibling[p.page.ParentID+"\x00"+p.page.Slug]) > 1 {
			clashes = append(clashes, kbTreeClash{pageID: p.pageID, kind: kb.ConflictMove})
		}
	}

	list := make([]kb.TreeNode, 0, len(nodes))
	for _, node := range nodes {
		list = append(list, node)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })

	return kb.NewPageTree(list), clashes, nil
}

func kbDraftPageVersion(state kbDraftPage) kb.PageVersion {
	header := make(map[string]any, len(state.header))
	for k, v := range state.header {
		header[k] = v
	}

	return kb.PageVersion{
		ParentID:    state.parentID,
		Position:    state.position,
		Slug:        state.slug,
		Frontmatter: header,
		Blocks:      state.blocks,
		Claims:      state.claims,
		Deleted:     state.op == kb.DraftOpDelete,
	}
}

func kbConflictResponses(pageID string, overlay kbOverlay, conflicts []kb.Conflict) []KbDraftConflictResponse {
	path, _ := overlay.tree.PathByPageID(pageID)
	out := make([]KbDraftConflictResponse, len(conflicts))
	for i, c := range conflicts {
		out[i] = KbDraftConflictResponse{
			PageID:     pageID,
			Path:       path,
			Kind:       c.Kind,
			BlockID:    c.BlockID,
			Key:        c.Key,
			MainLines:  c.MainLines,
			DraftLines: c.DraftLines,
		}
	}

	return out
}

func slicesSorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)

	return out
}

// canMaintainKb: the knowledge base creator and workspace owners and admins
// merge, revert and close (decision 102). A task token acts as the person it
// is bound to.
func canMaintainKb(member db.Member, base db.KbBase) bool {
	return isWorkspaceAdmin(member) || base.CreatedBy == member.UserID
}

// canCloseKbMergeRequest adds the author to canMaintainKb: an author may
// close their own request.
func canCloseKbMergeRequest(member db.Member, base db.KbBase, mr db.KbMergeRequest, actorType, actorID string) bool {
	if canMaintainKb(member, base) {
		return true
	}
	if mr.AuthorType == kbActorAgent {
		return actorType == kbActorAgent && uuidToString(mr.AuthorID) == actorID
	}

	return mr.AuthorID == member.UserID
}

// MergeKbMergeRequest merges a merge request into the mainline (POST
// /api/kb/merge-requests/{number}/merge; spec 6.3) in one transaction: the
// draft version must match what the reviewer saw, the draft must have no
// unresolved conflicts, and each page merges three ways over the mainline.
// Any conflict rolls the whole merge back.
func (h *Handler) MergeKbMergeRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req MergeKbMergeRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.DraftVersion == nil {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "draft_version is required")
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
	if !canMaintainKb(member, base) {
		h.writeKbError(w, r, kbFail(http.StatusForbidden, kbCodeForbidden, "only the knowledge base creator or an owner or admin can merge"))
		return
	}
	running, err := h.kbMergeRequestJobRunning(ctx, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if running {
		writeErrorCode(w, http.StatusConflict, kbCodeJobRunning, "the job's agent is still working on this draft")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	merged, err := h.mergeKbMergeRequest(ctx, base, mr, *req.DraftVersion, userID, actorType, actorID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestMerged(base, merged, actorType, actorID)

	resp, err := h.kbMergeRequestResponseOf(ctx, merged.mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// kbMergeOutcome is what a merge changed, for the events sent after commit.
type kbMergeOutcome struct {
	mr          db.KbMergeRequest
	draft       db.KbDraft
	pageIDs     []pgtype.UUID
	annotations []pgtype.UUID
}

func (h *Handler) mergeKbMergeRequest(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, draftVersion int64, userID, actorType, actorID string) (kbMergeOutcome, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kbMergeOutcome{}, errors.Wrap(err, "begin merge")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	draft, err := lockKbDraft(ctx, qtx, db.KbDraft{WorkspaceID: mr.WorkspaceID, ID: mr.DraftID})
	if err != nil {
		return kbMergeOutcome{}, err
	}
	locked, err := qtx.GetKbMergeRequestForUpdate(ctx, db.GetKbMergeRequestForUpdateParams{WorkspaceID: mr.WorkspaceID, ID: mr.ID})
	if err != nil {
		return kbMergeOutcome{}, errors.Wrapf(err, "lock merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if locked.Status == kb.MergeRequestStatusChangesRequested {
		return kbMergeOutcome{}, kbFail(http.StatusConflict, kbCodeChangesRequested, "a review asked for changes; the owner must request review again before merging")
	}
	if locked.Status != kb.MergeRequestStatusOpen {
		return kbMergeOutcome{}, kbFail(http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+locked.Status)
	}
	if draft.Version != draftVersion {
		return kbMergeOutcome{}, &kbRequestError{
			status:  http.StatusConflict,
			code:    kbCodeStaleDraftVersion,
			message: "the draft changed after you opened the merge request; reload and review it again",
			extra:   map[string]any{"draft_version": draft.Version},
		}
	}

	overlay, err := loadKbOverlay(ctx, qtx, base.ID, draft.ID)
	if err != nil {
		return kbMergeOutcome{}, err
	}
	if stored := kbDraftConflicts(overlay); len(stored) > 0 {
		return kbMergeOutcome{}, &kbRequestError{
			status:  http.StatusConflict,
			code:    kbCodeUnresolvedConflict,
			message: "the draft still has unresolved conflicts; resolve them in the draft first",
			extra:   map[string]any{"conflicts": stored},
		}
	}

	pageIDs := make([]pgtype.UUID, 0, len(overlay.order))
	for _, id := range overlay.order {
		pageIDs = append(pageIDs, parseUUID(id))
	}
	mainPages, err := qtx.LockKbPagesByIDs(ctx, db.LockKbPagesByIDsParams{KnowledgeBaseID: base.ID, Ids: pageIDs})
	if err != nil {
		return kbMergeOutcome{}, errors.Wrapf(err, "lock pages merge_request_id=%s", uuidToString(mr.ID))
	}

	plan, err := planKbMerge(ctx, qtx, base, overlay, mainPages)
	if err != nil {
		return kbMergeOutcome{}, err
	}
	if len(plan.conflicts) > 0 {
		return kbMergeOutcome{}, &kbRequestError{
			status:  http.StatusConflict,
			code:    kbCodeMergeConflict,
			message: "the draft conflicts with the mainline; run kb draft sync and resolve the conflicts first",
			extra:   map[string]any{"conflicts": plan.conflicts},
		}
	}

	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, []kbActor{{kind: mr.AuthorType, id: mr.AuthorID}})
	if err != nil {
		return kbMergeOutcome{}, err
	}
	generated := kb.Generated(names.name(mr.AuthorType, mr.AuthorID), time.Now())

	write := kb.MainlineWrite{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		MergeRequestID:  mr.ID,
		Tree:            plan.tree,
	}
	for _, p := range plan.pages {
		if !p.page.Deleted {
			p.page.Frontmatter[kb.MetaGenerated] = generated
		}
		write.Pages = append(write.Pages, kb.MainlinePage{PageID: parseUUID(p.pageID), PrevRevisionID: p.prev, Page: p.page})
	}
	written, err := kb.WriteMainline(ctx, qtx, write)
	if err != nil {
		if isUniqueViolation(err) {
			return kbMergeOutcome{}, kbFail(http.StatusConflict, kbCodeDuplicateSlug, "a merged page clashes with a sibling's slug; move or rename it in the draft")
		}

		return kbMergeOutcome{}, err
	}

	relocate := make(map[pgtype.UUID][]kb.Block)
	for _, p := range plan.pages {
		if p.onMainline {
			id := parseUUID(p.pageID)
			relocate[id] = written.Blocks[id]
		}
	}
	moved, err := kb.RelocateAnnotations(ctx, qtx, base.ID, relocate)
	if err != nil {
		return kbMergeOutcome{}, err
	}
	resolved, err := kb.ResolveAnnotations(ctx, qtx, mr.ID)
	if err != nil {
		return kbMergeOutcome{}, err
	}

	mergedMR, err := qtx.SetKbMergeRequestMerged(ctx, db.SetKbMergeRequestMergedParams{
		ID:       mr.ID,
		Status:   kb.MergeRequestStatusMerged,
		MergedBy: parseUUID(userID),
	})
	if err != nil {
		return kbMergeOutcome{}, errors.Wrapf(err, "mark merged merge_request_id=%s", uuidToString(mr.ID))
	}
	if err := recordKbMrEvent(ctx, qtx, mergedMR, actorType, actorID, kbMrEventMerged, nil); err != nil {
		return kbMergeOutcome{}, err
	}
	mergedDraft, err := qtx.SetKbDraftStatus(ctx, db.SetKbDraftStatusParams{ID: draft.ID, Status: kb.DraftStatusMerged})
	if err != nil {
		return kbMergeOutcome{}, errors.Wrapf(err, "mark draft merged draft_id=%s", uuidToString(draft.ID))
	}
	if err := qtx.BumpKbContentVersion(ctx, base.ID); err != nil {
		return kbMergeOutcome{}, errors.Wrapf(err, "bump content version knowledge_base_id=%s", uuidToString(base.ID))
	}

	if err := tx.Commit(ctx); err != nil {
		return kbMergeOutcome{}, errors.Wrap(err, "commit merge")
	}

	return kbMergeOutcome{
		mr:          mergedMR,
		draft:       mergedDraft,
		pageIDs:     pageIDs,
		annotations: append(moved, resolved...),
	}, nil
}

// publishKbMergeRequestMerged runs what follows a committed merge: the
// merged pages are queued for embedding, and kb.mr.merged, the annotation
// and job events go out.
func (h *Handler) publishKbMergeRequestMerged(base db.KbBase, out kbMergeOutcome, actorType, actorID string) {
	if h.KbEmbeddings != nil {
		h.KbEmbeddings.Enqueue(out.pageIDs...)
	}

	pageIDs := make([]string, len(out.pageIDs))
	for i, id := range out.pageIDs {
		pageIDs[i] = uuidToString(id)
	}
	h.publishKbMergeRequestEvent(protocol.EventKbMrMerged, out.mr, actorType, actorID, pageIDs)
	h.publishKbAnnotationIDs(base, actorType, actorID, out.annotations, pageIDs)
	h.publishKbMergeRequestJob(out.mr, out.draft, actorType, actorID)
}

// publishKbMergeRequestEvent sends one of the kb.mr.* events.
func (h *Handler) publishKbMergeRequestEvent(eventType string, mr db.KbMergeRequest, actorType, actorID string, pageIDs []string) {
	if pageIDs == nil {
		pageIDs = []string{}
	}
	var jobID any
	if mr.JobID.Valid {
		jobID = uuidToString(mr.JobID)
	}

	h.publish(eventType, uuidToString(mr.WorkspaceID), actorType, actorID, map[string]any{
		"merge_request_id":  uuidToString(mr.ID),
		"number":            mr.Number,
		"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
		"draft_id":          uuidToString(mr.DraftID),
		"job_id":            jobID,
		"status":            mr.Status,
		"page_ids":          pageIDs,
	})
}

func (h *Handler) publishKbAnnotationIDs(base db.KbBase, actorType, actorID string, ids []pgtype.UUID, pageIDs []string) {
	if len(ids) == 0 {
		return
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		s := uuidToString(id)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if pageIDs == nil {
		pageIDs = []string{}
	}

	h.publish(protocol.EventKbAnnotationChanged, uuidToString(base.WorkspaceID), actorType, actorID, map[string]any{
		"knowledge_base_id": uuidToString(base.ID),
		"annotation_ids":    out,
		"page_ids":          pageIDs,
	})
}

func (h *Handler) publishKbMergeRequestJob(mr db.KbMergeRequest, draft db.KbDraft, actorType, actorID string) {
	if !mr.JobID.Valid {
		return
	}

	h.publish(protocol.EventKbJobUpdated, uuidToString(mr.WorkspaceID), actorType, actorID, map[string]any{
		"job_id":            uuidToString(mr.JobID),
		"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
		"draft_id":          uuidToString(draft.ID),
	})
}

// kbMergeRequestJobRunning reports whether the job a request came from has an
// agent turn in flight (spec 7.9: no merging while the job works).
func (h *Handler) kbMergeRequestJobRunning(ctx context.Context, mr db.KbMergeRequest) (bool, error) {
	if !mr.JobID.Valid {
		return false, nil
	}

	rows, err := h.Queries.ListKbJobStates(ctx, db.ListKbJobStatesParams{
		RunningStatuses: kbRunningTaskStatuses,
		WorkspaceID:     mr.WorkspaceID,
		JobIds:          []pgtype.UUID{mr.JobID},
	})
	if err != nil {
		return false, errors.Wrapf(err, "load job state job_id=%s", uuidToString(mr.JobID))
	}

	return len(rows) > 0 && kbJobState(rows[0]) == kbJobStateRunning, nil
}

// CloseKbMergeRequest closes a merge request without merging (POST
// /api/kb/merge-requests/{number}/close): its annotations go back to
// pending and the draft opens again, so the job can resubmit it.
func (h *Handler) CloseKbMergeRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CloseKbMergeRequestRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
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
		h.writeKbError(w, r, kbFail(http.StatusForbidden, kbCodeForbidden, "only the author, the knowledge base creator or an owner or admin can close this merge request"))
		return
	}

	closed, draft, released, err := h.closeKbMergeRequest(ctx, mr, strings.TrimSpace(req.Reason), userID, actorType, actorID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestEvent(protocol.EventKbMrClosed, closed, actorType, actorID, nil)
	h.publishKbAnnotationIDs(base, actorType, actorID, released, nil)
	h.publishKbMergeRequestJob(closed, draft, actorType, actorID)

	resp, err := h.kbMergeRequestResponseOf(ctx, closed)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) closeKbMergeRequest(ctx context.Context, mr db.KbMergeRequest, reason, userID, actorType, actorID string) (db.KbMergeRequest, db.KbDraft, []pgtype.UUID, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, errors.Wrap(err, "begin close")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	draft, err := lockKbDraft(ctx, qtx, db.KbDraft{WorkspaceID: mr.WorkspaceID, ID: mr.DraftID})
	if err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, err
	}
	locked, err := qtx.GetKbMergeRequestForUpdate(ctx, db.GetKbMergeRequestForUpdateParams{WorkspaceID: mr.WorkspaceID, ID: mr.ID})
	if err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, errors.Wrapf(err, "lock merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if !isKbMergeRequestActive(locked.Status) {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, kbFail(http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+locked.Status)
	}

	closed, err := qtx.SetKbMergeRequestClosed(ctx, db.SetKbMergeRequestClosedParams{
		ID:          mr.ID,
		Status:      kb.MergeRequestStatusClosed,
		ClosedBy:    parseUUID(userID),
		CloseReason: reason,
	})
	if err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, errors.Wrapf(err, "close merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if err := recordKbMrEvent(ctx, qtx, closed, actorType, actorID, kbMrEventClosed, map[string]any{"close_reason": reason}); err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, err
	}
	if draft.Status == kb.DraftStatusSubmitted {
		if draft, err = qtx.SetKbDraftStatus(ctx, db.SetKbDraftStatusParams{ID: draft.ID, Status: kb.DraftStatusOpen}); err != nil {
			return db.KbMergeRequest{}, db.KbDraft{}, nil, errors.Wrapf(err, "reopen draft draft_id=%s", uuidToString(draft.ID))
		}
	}
	released, err := kb.ReleaseAnnotations(ctx, qtx, mr.ID)
	if err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return db.KbMergeRequest{}, db.KbDraft{}, nil, errors.Wrap(err, "commit close")
	}

	return closed, draft, released, nil
}
