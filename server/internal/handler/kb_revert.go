package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// kbRevertPage is one page of a revert draft.
type kbRevertPage struct {
	pageID pgtype.UUID
	op     string
	// head is the mainline head the revert is based on.
	head pgtype.UUID
	page kb.PageVersion
}

// RevertKbMergeRequest reverts a merged merge request (POST
// /api/kb/merge-requests/{number}/revert; spec 6.3): a new draft takes each
// page the request wrote back to the revision before it, three-way merged
// over the current mainline, and is opened as a source=revert merge request
// pointing at the original. Later changes to the same blocks conflict and
// nothing is created.
func (h *Handler) RevertKbMergeRequest(w http.ResponseWriter, r *http.Request) {
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
	if !canMaintainKb(member, base) {
		h.writeKbError(w, r, kbFail(http.StatusForbidden, kbCodeForbidden, "only the knowledge base creator or an owner or admin can revert"))
		return
	}
	if mr.Status != kb.MergeRequestStatusMerged {
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestNotMerged, "only a merged merge request can be reverted")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	var taskID pgtype.UUID
	if actorType == kbActorAgent {
		if task, found := h.taskFromRequestHeader(r); found {
			taskID = task.ID
		}
	}

	created, draft, err := h.revertKbMergeRequest(ctx, base, mr, kbOpenMergeRequest{
		title:      fmt.Sprintf("Revert #%d: %s", mr.Number, mr.Title),
		summary:    fmt.Sprintf("Reverts #%d.", mr.Number),
		source:     kb.MergeRequestSourceRevert,
		risk:       mr.Risk,
		authorType: actorType,
		authorID:   parseUUID(actorID),
	}, userID, taskID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestCreated(created, draft, nil, actorType, actorID)

	resp, err := h.kbMergeRequestResponseOf(ctx, created.MergeRequest)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) revertKbMergeRequest(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, in kbOpenMergeRequest, userID string, taskID pgtype.UUID) (kb.CreatedMergeRequest, db.KbDraft, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrap(err, "begin revert")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	pages, err := planKbRevert(ctx, qtx, base, mr)
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}

	draft, err := qtx.CreateKbDraft(ctx, db.CreateKbDraftParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Title:           in.title,
		CreatedBy:       parseUUID(userID),
		TaskID:          taskID,
	})
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrapf(err, "create revert draft merge_request_id=%s", uuidToString(mr.ID))
	}
	if draft, err = qtx.BumpKbDraftVersion(ctx, draft.ID); err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrapf(err, "bump revert draft draft_id=%s", uuidToString(draft.ID))
	}

	params := db.CreateKbDraftPagesParams{DraftID: draft.ID, Version: draft.Version}
	for _, p := range pages {
		header, err := json.Marshal(p.page.Frontmatter)
		if err != nil {
			return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.WithStack(err)
		}
		blocks, err := json.Marshal(p.page.Blocks)
		if err != nil {
			return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.WithStack(err)
		}
		claims, err := json.Marshal(p.page.Claims)
		if err != nil {
			return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.WithStack(err)
		}
		parentID, err := optionalPgUUID(p.page.ParentID)
		if err != nil {
			return kb.CreatedMergeRequest{}, db.KbDraft{}, err
		}
		params.PageIds = append(params.PageIds, p.pageID)
		params.Ops = append(params.Ops, p.op)
		params.BaseRevisionIds = append(params.BaseRevisionIds, p.head)
		params.ParentIds = append(params.ParentIds, parentID)
		params.Positions = append(params.Positions, p.page.Position)
		params.Slugs = append(params.Slugs, p.page.Slug)
		params.Frontmatters = append(params.Frontmatters, header)
		params.Blocks = append(params.Blocks, blocks)
		params.Claims = append(params.Claims, claims)
	}
	if err := qtx.CreateKbDraftPages(ctx, params); err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrapf(err, "write revert draft draft_id=%s", uuidToString(draft.ID))
	}

	created, err := kb.CreateMergeRequest(ctx, qtx, kb.NewMergeRequest{
		Draft:      draft,
		Title:      in.title,
		Summary:    in.summary,
		Source:     in.source,
		Risk:       in.risk,
		AuthorType: in.authorType,
		AuthorID:   in.authorID,
		RevertsID:  mr.ID,
	})
	if err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}
	if err := recordKbMrEvent(ctx, qtx, mr, in.authorType, uuidToString(in.authorID), kbMrEventReverted, map[string]any{
		"revert_number": created.MergeRequest.Number,
	}); err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kb.CreatedMergeRequest{}, db.KbDraft{}, errors.Wrap(err, "commit revert")
	}

	return created, draft, nil
}

// planKbRevert works out the revert draft's pages. Pages already back where
// they were are left out; when none is left there is nothing to revert.
func planKbRevert(ctx context.Context, q *db.Queries, base db.KbBase, mr db.KbMergeRequest) ([]kbRevertPage, error) {
	afterRows, err := q.ListKbRevisionsByMergeRequest(ctx, db.ListKbRevisionsByMergeRequestParams{KnowledgeBaseID: base.ID, MergeRequestID: mr.ID})
	if err != nil {
		return nil, errors.Wrapf(err, "list merged revisions merge_request_id=%s", uuidToString(mr.ID))
	}
	if len(afterRows) == 0 {
		return nil, kbFail(http.StatusConflict, kbCodeNothingToRevert, "the merge request wrote no pages")
	}

	pageIDs := make([]pgtype.UUID, 0, len(afterRows))
	for _, rev := range afterRows {
		pageIDs = append(pageIDs, rev.PageID)
	}
	current, err := q.ListKbPagesByIDs(ctx, db.ListKbPagesByIDsParams{KnowledgeBaseID: base.ID, Ids: pageIDs})
	if err != nil {
		return nil, errors.Wrapf(err, "list current pages merge_request_id=%s", uuidToString(mr.ID))
	}
	currentByID := make(map[pgtype.UUID]db.KbPage, len(current))
	revisionIDs := make([]pgtype.UUID, 0, 2*len(afterRows))
	for _, page := range current {
		currentByID[page.ID] = page
		revisionIDs = append(revisionIDs, page.HeadRevisionID)
	}
	for _, rev := range afterRows {
		if rev.PrevRevisionID.Valid {
			revisionIDs = append(revisionIDs, rev.PrevRevisionID)
		}
	}
	revRows, err := q.ListKbPageRevisionsByIDs(ctx, db.ListKbPageRevisionsByIDsParams{KnowledgeBaseID: base.ID, Ids: revisionIDs})
	if err != nil {
		return nil, errors.Wrapf(err, "list revert revisions merge_request_id=%s", uuidToString(mr.ID))
	}
	revisions := make(map[pgtype.UUID]db.KbPageRevision, len(revRows))
	for _, rev := range revRows {
		revisions[rev.ID] = rev
	}
	mainTree, err := loadKbTreeWith(ctx, q, base.ID, nil)
	if err != nil {
		return nil, err
	}

	out := make([]kbRevertPage, 0, len(afterRows))
	conflicts := make([]KbDraftConflictResponse, 0)
	for _, afterRev := range afterRows {
		page, ok := currentByID[afterRev.PageID]
		if !ok {
			return nil, errors.Errorf("missing page for revision_id=%s", uuidToString(afterRev.ID))
		}
		after, err := kbRevisionVersion(afterRev)
		if err != nil {
			return nil, err
		}
		before := kb.PageVersion{ParentID: after.ParentID, Position: after.Position, Slug: after.Slug, Frontmatter: map[string]any{}, Blocks: []kb.Block{}, Claims: []kb.Claim{}, Deleted: true}
		if afterRev.PrevRevisionID.Valid {
			prev, ok := revisions[afterRev.PrevRevisionID]
			if !ok {
				return nil, errors.Errorf("missing revision_id=%s", uuidToString(afterRev.PrevRevisionID))
			}
			if before, err = kbRevisionVersion(prev); err != nil {
				return nil, err
			}
		}
		headRev, ok := revisions[page.HeadRevisionID]
		if !ok {
			return nil, errors.Errorf("missing head revision page_id=%s", uuidToString(page.ID))
		}
		now, err := kbRevisionVersion(headRev)
		if err != nil {
			return nil, err
		}

		result := kb.RevertPage(before, after, now, page.HeadRevisionID == afterRev.ID)
		if len(result.Conflicts) > 0 {
			path, _ := mainTree.PathByPageID(uuidToString(page.ID))
			for _, c := range result.Conflicts {
				conflicts = append(conflicts, KbDraftConflictResponse{
					PageID: uuidToString(page.ID), Path: path, Kind: c.Kind, BlockID: c.BlockID, Key: c.Key,
					MainLines: c.MainLines, DraftLines: c.DraftLines,
				})
			}
			continue
		}
		if kbSamePageVersion(result.Page, now) {
			continue
		}

		target := result.Page
		if target.Frontmatter == nil {
			target.Frontmatter = map[string]any{}
		}
		if !target.Deleted {
			target.Frontmatter[kb.MetaSources] = kbSourcesHeader(target.Blocks, target.Claims)
		}
		out = append(out, kbRevertPage{pageID: page.ID, op: kbRevertOp(target, now), head: page.HeadRevisionID, page: target})
	}

	// The reverted pages must still fit the tree as it is now: a page put
	// back under a parent deleted since, a page removed while it gained
	// children, or a slug taken since.
	if len(conflicts) == 0 && len(out) > 0 {
		merged := make([]kbMergePage, 0, len(out))
		for _, r := range out {
			merged = append(merged, kbMergePage{pageID: uuidToString(r.pageID), page: r.page})
		}
		_, clashes, err := kbMergedTree(ctx, q, base, merged)
		if err != nil {
			return nil, err
		}
		for _, c := range clashes {
			path, _ := mainTree.PathByPageID(c.pageID)
			conflicts = append(conflicts, KbDraftConflictResponse{PageID: c.pageID, Path: path, Kind: c.kind})
		}
	}

	if len(conflicts) > 0 {
		return nil, &kbRequestError{
			status:  http.StatusConflict,
			code:    kbCodeRevertConflict,
			message: "later changes touched the same content; revert by hand",
			extra:   map[string]any{"conflicts": conflicts},
		}
	}
	if len(out) == 0 {
		return nil, kbFail(http.StatusConflict, kbCodeNothingToRevert, "the mainline already matches the state before this merge request")
	}

	return out, nil
}

// kbRevertOp is the draft op of a reverted page: deleted, moved only, or
// changed (a page the revert brings back counts as changed).
func kbRevertOp(target, now kb.PageVersion) string {
	switch {
	case target.Deleted:
		return kb.DraftOpDelete
	case !now.Deleted && reflect.DeepEqual(target.Blocks, now.Blocks) && kbSameHeader(target.Frontmatter, now.Frontmatter):
		return kb.DraftOpMove
	}

	return kb.DraftOpUpdate
}

func kbSamePageVersion(a, b kb.PageVersion) bool {
	if a.Deleted || b.Deleted {
		return a.Deleted == b.Deleted
	}

	return a.ParentID == b.ParentID && a.Position == b.Position && a.Slug == b.Slug &&
		reflect.DeepEqual(a.Blocks, b.Blocks) && kbSameHeader(a.Frontmatter, b.Frontmatter) && jsonEqualAny(a.Claims, b.Claims)
}

// kbSameHeader compares page headers without the keys Marvis maintains: a
// page whose content is back as it was still carries a newer generated.
func kbSameHeader(a, b map[string]any) bool {
	strip := func(h map[string]any) map[string]any {
		out := make(map[string]any, len(h))
		for k, v := range h {
			if k != kb.MetaGenerated && k != kb.MetaSources {
				out[k] = v
			}
		}

		return out
	}

	return jsonEqualAny(strip(a), strip(b))
}

func jsonEqualAny(a, b any) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)

	return errA == nil && errB == nil && string(ja) == string(jb)
}
