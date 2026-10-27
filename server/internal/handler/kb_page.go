package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// draftVersionPrefix marks the version of a page read from a draft: d<draft
// version>. Mainline pages report their revision id.
const draftVersionPrefix = "d"

// Actor types of merge request authors and annotation authors.
const (
	kbActorAgent  = kb.ActorAgent
	kbActorMember = kb.ActorMember
)

// liveDraftStatuses are the draft states whose changes are still pending.
var liveDraftStatuses = []string{kb.DraftStatusOpen, kb.DraftStatusSubmitted}

// KbPageLinkResponse is a page referenced from another page: a breadcrumb
// entry or a backlink.
type KbPageLinkResponse struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// KbBlockResponse is one body block; kb:// links are app routes.
type KbBlockResponse struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

// KbRawFileResponse describes the raw file a raw:// source points at.
type KbRawFileResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	UploadedBy  string `json:"uploaded_by"`
	CreatedAt   string `json:"created_at"`
	// Page is the cited PDF page, 0 when none.
	Page int `json:"page"`
}

// KbSourceResponse is one cited source of a page.
type KbSourceResponse struct {
	ID       string             `json:"id"`
	Kind     string             `json:"kind"`
	URI      string             `json:"uri"`
	Title    string             `json:"title"`
	Version  string             `json:"version"`
	Openable bool               `json:"openable"`
	Raw      *KbRawFileResponse `json:"raw"`
}

// KbClaimResponse locates a claim on the page.
type KbClaimResponse struct {
	Key       string `json:"key"`
	BlockID   string `json:"block_id"`
	Text      string `json:"text"`
	CheckedAt string `json:"checked_at"`
}

// KbLastMergeResponse is the merge that produced the current revision.
type KbLastMergeResponse struct {
	Number     int32  `json:"number"`
	AuthorType string `json:"author_type"`
	AuthorID   string `json:"author_id"`
	AuthorName string `json:"author_name"`
	MergedAt   string `json:"merged_at"`
}

// KbMergeRequestRefResponse is a merge request named next to a page.
type KbMergeRequestRefResponse struct {
	Number int32  `json:"number"`
	Title  string `json:"title"`
}

// KbDraftOriginResponse says where a draft was started.
type KbDraftOriginResponse struct {
	Type  string `json:"type"`
	Label string `json:"label"`
	RefID string `json:"ref_id"`
}

// KbPageDraftResponse is one of the caller's drafts that change the page.
type KbPageDraftResponse struct {
	ID            string                `json:"id"`
	Title         string                `json:"title"`
	Status        string                `json:"status"`
	UpdatedAt     string                `json:"updated_at"`
	DraftChange   string                `json:"draft_change"`
	ChangedBlocks int                   `json:"changed_blocks"`
	Origin        KbDraftOriginResponse `json:"origin"`
	// MergeRequest is the merge request under review made from the draft,
	// nil until it is submitted.
	MergeRequest *KbPendingMergeRequestResponse `json:"merge_request"`
}

// KbPendingMergeRequestResponse is a merge request under review (open or
// changes requested) that changes the page.
type KbPendingMergeRequestResponse struct {
	Number int32  `json:"number"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// KbPageResponse is a page as the reading page shows it (GET
// /api/kb/pages/{id}).
type KbPageResponse struct {
	ID              string                     `json:"id"`
	KnowledgeBaseID string                     `json:"knowledge_base_id"`
	Path            string                     `json:"path"`
	Version         string                     `json:"version"`
	Breadcrumb      []KbPageLinkResponse       `json:"breadcrumb"`
	Frontmatter     map[string]any             `json:"frontmatter"`
	Blocks          []KbBlockResponse          `json:"blocks"`
	Sources         []KbSourceResponse         `json:"sources"`
	Claims          []KbClaimResponse          `json:"claims"`
	LastMR          *KbLastMergeResponse       `json:"last_mr"`
	UpdatedAt       string                     `json:"updated_at"`
	Stale           bool                       `json:"stale"`
	Backlinks       []KbPageLinkResponse       `json:"backlinks"`
	PendingMR       *KbMergeRequestRefResponse `json:"pending_mr"`
	PendingMRCount  int                        `json:"pending_mr_count"`
	// PendingMRs are the open merge requests that change the page, except
	// those made from the caller's drafts, newest first.
	PendingMRs      []KbPendingMergeRequestResponse `json:"pending_mrs"`
	AnnotationsOpen int64                           `json:"annotations_open"`
	// DraftChange is what the requested draft did to this page.
	DraftChange string `json:"draft_change"`
	// Drafts are the caller's live drafts that change this page.
	Drafts []KbPageDraftResponse `json:"drafts"`
}

// kbPageSource is the page content a view is built from: the mainline row or
// a draft's copy.
type kbPageSource struct {
	base       db.KbBase
	pageID     pgtype.UUID
	version    string
	updatedAt  pgtype.Timestamptz
	staleAfter pgtype.Timestamptz
	header     []byte
	blocks     []byte
	// draftClaims is the claims snapshot of a draft copy; mainline claims
	// live in kb_claim.
	draftClaims []byte
	// mainline is the mainline row, nil for a page only a draft has.
	mainline    *db.KbPage
	draft       *db.KbDraft
	draftChange string
}

// GetKbPage reads one page. {id} is a page id or a <kb slug>:<path>
// reference; ?draft=<id> reads the caller's draft copy of the page.
func (h *Handler) GetKbPage(w http.ResponseWriter, r *http.Request) {
	src, ok := h.loadKbPageSource(w, r, kbPageRefParam(r), r.URL.Query().Get("draft"))
	if !ok {
		return
	}

	view, err := h.buildKbPageView(r.Context(), src, requestUserID(r))
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, view)
}

// loadKbPageSource resolves a page reference, optionally through a draft.
// It writes the error response and returns false when it cannot.
func (h *Handler) loadKbPageSource(w http.ResponseWriter, r *http.Request, ref, draftParam string) (kbPageSource, bool) {
	ctx := r.Context()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return kbPageSource{}, false
	}

	var draft *db.KbDraft
	if draftParam != "" {
		d, ok := h.loadKbDraftForReader(w, r, wsUUID, draftParam)
		if !ok {
			return kbPageSource{}, false
		}
		draft = &d
	}

	base, pageID, ok := h.resolveKbPageRef(w, r, wsUUID, ref, draft)
	if !ok {
		return kbPageSource{}, false
	}
	if draft != nil && draft.KnowledgeBaseID != base.ID {
		writeError(w, http.StatusNotFound, "draft not found")
		return kbPageSource{}, false
	}

	var mainline *db.KbPage
	page, err := h.Queries.GetKbPage(ctx, db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: pageID})
	switch {
	case err == nil:
		mainline = &page
	case !isNotFound(err):
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load page page_id=%s", uuidToString(pageID)))
		return kbPageSource{}, false
	}

	if draft != nil {
		dp, err := h.Queries.GetKbDraftPage(ctx, db.GetKbDraftPageParams{DraftID: draft.ID, PageID: pageID})
		switch {
		case err == nil:
			return kbPageSource{
				base:        base,
				pageID:      pageID,
				version:     fmt.Sprintf("%s%d", draftVersionPrefix, draft.Version),
				updatedAt:   dp.UpdatedAt,
				staleAfter:  staleAfterOf(mainline),
				header:      dp.Frontmatter,
				blocks:      dp.Blocks,
				draftClaims: dp.Claims,
				mainline:    mainline,
				draft:       draft,
				draftChange: kb.DraftChange(dp.Op),
			}, true
		case !isNotFound(err):
			h.writeKbInternalError(w, r, errors.Wrapf(err, "load draft page draft_id=%s page_id=%s", uuidToString(draft.ID), uuidToString(pageID)))
			return kbPageSource{}, false
		}
	}

	if mainline == nil || mainline.DeletedAt.Valid {
		writeError(w, http.StatusNotFound, "page not found")
		return kbPageSource{}, false
	}

	return kbPageSource{
		base:       base,
		pageID:     pageID,
		version:    uuidToString(mainline.HeadRevisionID),
		updatedAt:  mainline.UpdatedAt,
		staleAfter: mainline.StaleAfter,
		header:     mainline.Frontmatter,
		blocks:     mainline.Blocks,
		mainline:   mainline,
		draft:      draft,
	}, true
}

// loadKbDraftForReader loads a draft the caller may read: its creator, the
// creator of the job it is linked to, or whoever may merge into its
// knowledge base (the knowledge base creator, a workspace owner or admin).
func (h *Handler) loadKbDraftForReader(w http.ResponseWriter, r *http.Request, wsUUID pgtype.UUID, draftParam string) (db.KbDraft, bool) {
	draftID, ok := parseUUIDOrBadRequest(w, draftParam, "draft")
	if !ok {
		return db.KbDraft{}, false
	}

	draft, err := h.Queries.GetKbDraftInWorkspace(r.Context(), db.GetKbDraftInWorkspaceParams{WorkspaceID: wsUUID, ID: draftID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "draft not found")
			return db.KbDraft{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load draft draft_id=%s", draftParam))
		return db.KbDraft{}, false
	}
	readable, err := h.canReadKbDraft(r.Context(), draft, requestUserID(r))
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return db.KbDraft{}, false
	}
	if !readable {
		if readable, err = h.canMaintainKbOfDraft(r.Context(), draft, requestUserID(r)); err != nil {
			h.writeKbInternalError(w, r, err)
			return db.KbDraft{}, false
		}
	}
	if !readable {
		writeErrorCode(w, http.StatusForbidden, kbCodeForbidden, "only the draft creator, the creator of its job, the knowledge base creator or an owner or admin can read it")
		return db.KbDraft{}, false
	}

	return draft, true
}

// canMaintainKbOfDraft reports whether a user may merge into the draft's
// knowledge base (its creator, a workspace owner or admin); someone outside
// the workspace may not.
func (h *Handler) canMaintainKbOfDraft(ctx context.Context, draft db.KbDraft, userID string) (bool, error) {
	member, err := h.getWorkspaceMember(ctx, userID, uuidToString(draft.WorkspaceID))
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}

		return false, errors.Wrapf(err, "load member of draft reader draft_id=%s", uuidToString(draft.ID))
	}
	base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: draft.WorkspaceID, ID: draft.KnowledgeBaseID})
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}

		return false, errors.Wrapf(err, "load knowledge base of draft draft_id=%s", uuidToString(draft.ID))
	}

	return canMaintainKb(member, base), nil
}

// canReadKbDraft reports whether a user may read a draft: its creator, or the
// creator of the job it is linked to. An agent creates a job's draft as the
// person its task token is bound to (the runtime owner), who need not be the
// member who started the job.
func (h *Handler) canReadKbDraft(ctx context.Context, draft db.KbDraft, userID string) (bool, error) {
	if uuidToString(draft.CreatedBy) == userID {
		return true, nil
	}

	job, err := h.Queries.GetKbJobByDraft(ctx, draft.ID)
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}

		return false, errors.Wrapf(err, "load job of draft draft_id=%s", uuidToString(draft.ID))
	}

	return uuidToString(job.CreatedBy) == userID, nil
}

// resolveKbPageRef finds the knowledge base and page id a reference names.
// Paths resolve against the draft's tree when a draft is given, so a page the
// draft creates can be addressed by path too.
func (h *Handler) resolveKbPageRef(w http.ResponseWriter, r *http.Request, wsUUID pgtype.UUID, ref string, draft *db.KbDraft) (db.KbBase, pgtype.UUID, bool) {
	ctx := r.Context()
	parsed := kb.ParsePageRef(ref)

	if parsed.PageID != "" {
		pageID, ok := parseUUIDOrBadRequest(w, parsed.PageID, "id")
		if !ok {
			return db.KbBase{}, pgtype.UUID{}, false
		}

		baseID, err := h.kbBaseIDOfPage(ctx, wsUUID, pageID, draft)
		if err != nil {
			if isNotFound(err) {
				writeError(w, http.StatusNotFound, "page not found")
				return db.KbBase{}, pgtype.UUID{}, false
			}
			h.writeKbInternalError(w, r, err)
			return db.KbBase{}, pgtype.UUID{}, false
		}

		base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: baseID})
		if err != nil {
			if isNotFound(err) {
				writeError(w, http.StatusNotFound, "page not found")
				return db.KbBase{}, pgtype.UUID{}, false
			}
			h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of page page_id=%s", parsed.PageID))
			return db.KbBase{}, pgtype.UUID{}, false
		}

		return base, pageID, true
	}

	if parsed.KbSlug == "" {
		writeError(w, http.StatusBadRequest, "page reference needs a knowledge base: <kb>:/<path>")
		return db.KbBase{}, pgtype.UUID{}, false
	}
	base, ok := h.loadKbBaseForUser(w, r, parsed.KbSlug)
	if !ok {
		return db.KbBase{}, pgtype.UUID{}, false
	}

	tree, err := h.loadKbTree(ctx, base.ID, draft)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return db.KbBase{}, pgtype.UUID{}, false
	}
	id, found := tree.PageIDByPath(parsed.Path)
	if !found {
		writeError(w, http.StatusNotFound, "page not found")
		return db.KbBase{}, pgtype.UUID{}, false
	}

	return base, parseUUID(id), true
}

// kbBaseIDOfPage finds which knowledge base a page id belongs to: its
// mainline row, or the draft's copy for a page only the draft has.
func (h *Handler) kbBaseIDOfPage(ctx context.Context, wsUUID, pageID pgtype.UUID, draft *db.KbDraft) (pgtype.UUID, error) {
	page, err := h.Queries.GetKbPageInWorkspace(ctx, db.GetKbPageInWorkspaceParams{WorkspaceID: wsUUID, ID: pageID})
	if err == nil {
		return page.KnowledgeBaseID, nil
	}
	if !isNotFound(err) || draft == nil {
		return pgtype.UUID{}, errors.Wrapf(err, "load page page_id=%s", uuidToString(pageID))
	}

	if _, err := h.Queries.GetKbDraftPage(ctx, db.GetKbDraftPageParams{DraftID: draft.ID, PageID: pageID}); err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "load draft page page_id=%s", uuidToString(pageID))
	}

	return draft.KnowledgeBaseID, nil
}

// loadKbTree builds the page tree of a knowledge base, with a draft's
// moves, renames and new pages laid over the mainline when a draft is given.
func (h *Handler) loadKbTree(ctx context.Context, baseID pgtype.UUID, draft *db.KbDraft) (*kb.PageTree, error) {
	return loadKbTreeWith(ctx, h.Queries, baseID, draft)
}

// loadKbTreeWith is loadKbTree on the given queries, so a write transaction
// sees its own draft rows.
func loadKbTreeWith(ctx context.Context, q *db.Queries, baseID pgtype.UUID, draft *db.KbDraft) (*kb.PageTree, error) {
	rows, err := q.ListKbPageTree(ctx, baseID)
	if err != nil {
		return nil, errors.Wrapf(err, "list page tree knowledge_base_id=%s", uuidToString(baseID))
	}

	nodes := make(map[string]kb.TreeNode, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		id := uuidToString(row.ID)
		nodes[id] = kb.TreeNode{ID: id, ParentID: uuidOrEmpty(row.ParentID), Slug: row.Slug, Title: row.Title, Position: row.Position}
		order = append(order, id)
	}

	if draft != nil {
		pages, err := q.ListKbDraftPages(ctx, db.ListKbDraftPagesParams{KnowledgeBaseID: baseID, DraftID: draft.ID})
		if err != nil {
			return nil, errors.Wrapf(err, "list draft pages draft_id=%s", uuidToString(draft.ID))
		}
		for _, page := range pages {
			_, header, err := kb.ParseFrontmatter(page.Frontmatter)
			if err != nil {
				return nil, errors.Wrapf(err, "draft page page_id=%s", uuidToString(page.PageID))
			}
			id := uuidToString(page.PageID)
			if _, known := nodes[id]; !known {
				order = append(order, id)
			}
			nodes[id] = kb.TreeNode{ID: id, ParentID: uuidOrEmpty(page.ParentID), Slug: page.Slug, Title: header.Title, Position: page.Position}
		}
	}

	list := make([]kb.TreeNode, len(order))
	for i, id := range order {
		list[i] = nodes[id]
	}

	return kb.NewPageTree(list), nil
}

// buildKbPageView assembles the reading view of a page.
func (h *Handler) buildKbPageView(ctx context.Context, src kbPageSource, userID string) (KbPageResponse, error) {
	pageIDText := uuidToString(src.pageID)

	header, _, err := kb.ParseFrontmatter(src.header)
	if err != nil {
		return KbPageResponse{}, errors.Wrapf(err, "page_id=%s", pageIDText)
	}
	blocks, err := kb.ParseBlocks(src.blocks)
	if err != nil {
		return KbPageResponse{}, errors.Wrapf(err, "page_id=%s", pageIDText)
	}

	var claims []kb.Claim
	if src.draftClaims != nil {
		claims, err = kb.ParseClaims(src.draftClaims)
	} else {
		claims, err = h.loadKbMainlineClaims(ctx, src.base.ID, src.pageID)
	}
	if err != nil {
		return KbPageResponse{}, errors.Wrapf(err, "page_id=%s", pageIDText)
	}

	tree, err := h.loadKbTree(ctx, src.base.ID, src.draft)
	if err != nil {
		return KbPageResponse{}, err
	}
	path, _ := tree.PathByPageID(pageIDText)
	breadcrumb := make([]KbPageLinkResponse, 0)
	for _, node := range tree.Ancestors(pageIDText) {
		breadcrumb = append(breadcrumb, KbPageLinkResponse{ID: node.ID, Title: node.Title})
	}

	sources, err := h.kbSourceViews(ctx, src.base, userID, kb.SourcesFromClaims(blocks, claims))
	if err != nil {
		return KbPageResponse{}, err
	}
	rawIDs, err := h.loadKbBodyRawIDs(ctx, src.base.ID, blocks)
	if err != nil {
		return KbPageResponse{}, err
	}

	view := KbPageResponse{
		ID:              pageIDText,
		KnowledgeBaseID: uuidToString(src.base.ID),
		Path:            path,
		Version:         src.version,
		Breadcrumb:      breadcrumb,
		Frontmatter:     header,
		Blocks:          kbBlocksToResponse(kb.RawLinks(kb.RouteLinks(blocks, src.base.Slug), rawIDs)),
		Sources:         sources,
		Claims:          kbClaimsToResponse(claims),
		UpdatedAt:       timestampToString(src.updatedAt),
		Stale:           kbIsStale(src.staleAfter),
		Backlinks:       []KbPageLinkResponse{},
		DraftChange:     src.draftChange,
		Drafts:          []KbPageDraftResponse{},
		PendingMRs:      []KbPendingMergeRequestResponse{},
	}

	if src.mainline == nil {
		return view, nil
	}

	if err := h.fillKbPageActivity(ctx, src, userID, &view); err != nil {
		return KbPageResponse{}, err
	}

	return view, nil
}

// fillKbPageActivity adds what only a mainline page has: its last merge,
// backlinks, pending merge requests, open annotations and the caller's drafts.
func (h *Handler) fillKbPageActivity(ctx context.Context, src kbPageSource, userID string, view *KbPageResponse) error {
	page := src.mainline

	lastMR, err := h.loadKbLastMerge(ctx, page)
	if err != nil {
		return err
	}
	view.LastMR = lastMR

	backlinks, err := h.Queries.ListKbBacklinks(ctx, db.ListKbBacklinksParams{KnowledgeBaseID: src.base.ID, PageID: page.ID})
	if err != nil {
		return errors.Wrapf(err, "list backlinks page_id=%s", uuidToString(page.ID))
	}
	for _, link := range backlinks {
		view.Backlinks = append(view.Backlinks, KbPageLinkResponse{ID: uuidToString(link.ID), Title: link.Title})
	}

	pending, err := h.Queries.ListKbOpenMergeRequestsForPage(ctx, db.ListKbOpenMergeRequestsForPageParams{
		KnowledgeBaseID: src.base.ID,
		Statuses:        kbActiveMergeRequestStatuses,
		PageID:          page.ID,
	})
	if err != nil {
		return errors.Wrapf(err, "list pending merge requests page_id=%s", uuidToString(page.ID))
	}
	view.PendingMRCount = len(pending)
	if len(pending) > 0 {
		view.PendingMR = &KbMergeRequestRefResponse{Number: pending[0].Number, Title: pending[0].Title}
	}

	annotations, err := h.Queries.CountKbAnnotationsByPage(ctx, db.CountKbAnnotationsByPageParams{
		KnowledgeBaseID: src.base.ID,
		PageIds:         []pgtype.UUID{page.ID},
		Status:          kb.AnnotationStatusPending,
	})
	if err != nil {
		return errors.Wrapf(err, "count annotations page_id=%s", uuidToString(page.ID))
	}
	for _, row := range annotations {
		view.AnnotationsOpen = row.AnnotationCount
	}

	drafts, err := h.loadKbPageDrafts(ctx, src.base, page, userID)
	if err != nil {
		return err
	}
	view.Drafts = drafts

	attachKbPageMergeRequests(view, pending)

	return nil
}

// attachKbPageMergeRequests hands each of the caller's drafts its open merge
// request and lists the others as pending.
func attachKbPageMergeRequests(view *KbPageResponse, pending []db.ListKbOpenMergeRequestsForPageRow) {
	own := make(map[string]int, len(view.Drafts))
	for i, draft := range view.Drafts {
		own[draft.ID] = i
	}

	for _, mr := range pending {
		if i, ok := own[uuidToString(mr.DraftID)]; ok {
			if view.Drafts[i].MergeRequest == nil {
				view.Drafts[i].MergeRequest = &KbPendingMergeRequestResponse{Number: mr.Number, Title: mr.Title, Status: mr.Status}
			}
			continue
		}
		view.PendingMRs = append(view.PendingMRs, KbPendingMergeRequestResponse{
			Number: mr.Number,
			Title:  mr.Title,
			Status: mr.Status,
		})
	}
}

func (h *Handler) loadKbMainlineClaims(ctx context.Context, baseID, pageID pgtype.UUID) ([]kb.Claim, error) {
	rows, err := h.Queries.ListKbClaimsByPage(ctx, db.ListKbClaimsByPageParams{KnowledgeBaseID: baseID, PageID: pageID})
	if err != nil {
		return nil, errors.Wrapf(err, "list claims page_id=%s", uuidToString(pageID))
	}

	claims := make([]kb.Claim, len(rows))
	for i, row := range rows {
		var evidence []kb.Evidence
		if err := json.Unmarshal(row.Evidence, &evidence); err != nil {
			return nil, errors.Wrapf(err, "decode evidence claim_id=%s", uuidToString(row.ID))
		}
		claims[i] = kb.Claim{
			Key:       row.Key,
			BlockID:   row.BlockID,
			Text:      row.Text,
			Evidence:  evidence,
			CheckedAt: timestampToString(row.CheckedAt),
		}
	}

	return claims, nil
}

// loadKbLastMerge returns the merge that produced the page's current
// revision, or nil for the initial revision.
func (h *Handler) loadKbLastMerge(ctx context.Context, page *db.KbPage) (*KbLastMergeResponse, error) {
	mr, err := h.Queries.GetKbRevisionMergeRequest(ctx, db.GetKbRevisionMergeRequestParams{PageID: page.ID, ID: page.HeadRevisionID})
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}

		return nil, errors.Wrapf(err, "load last merge page_id=%s", uuidToString(page.ID))
	}

	names, err := h.loadKbActorNames(ctx, page.WorkspaceID, []kbActor{{kind: mr.AuthorType, id: mr.AuthorID}})
	if err != nil {
		return nil, err
	}

	return &KbLastMergeResponse{
		Number:     mr.Number,
		AuthorType: mr.AuthorType,
		AuthorID:   uuidToString(mr.AuthorID),
		AuthorName: names.name(mr.AuthorType, mr.AuthorID),
		MergedAt:   timestampToString(mr.MergedAt),
	}, nil
}

// loadKbPageDrafts lists the caller's live drafts that change the page.
func (h *Handler) loadKbPageDrafts(ctx context.Context, base db.KbBase, page *db.KbPage, userID string) ([]KbPageDraftResponse, error) {
	userUUID, ok := memberUUID(userID)
	if !ok {
		return []KbPageDraftResponse{}, nil
	}

	rows, err := h.Queries.ListKbUserDraftsForPage(ctx, db.ListKbUserDraftsForPageParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		CreatedBy:       userUUID,
		Statuses:        liveDraftStatuses,
		PageID:          page.ID,
		ReopenedStatus:  kb.DraftStatusOpen,
		ClosedStatus:    kb.MergeRequestStatusClosed,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list drafts page_id=%s", uuidToString(page.ID))
	}

	mainBlocks, err := kb.ParseBlocks(page.Blocks)
	if err != nil {
		return nil, errors.Wrapf(err, "page_id=%s", uuidToString(page.ID))
	}

	drafts := make([]KbPageDraftResponse, 0, len(rows))
	for _, row := range rows {
		draftBlocks, err := kb.ParseBlocks(row.Blocks)
		if err != nil {
			return nil, errors.Wrapf(err, "draft_id=%s", uuidToString(row.ID))
		}
		drafts = append(drafts, KbPageDraftResponse{
			ID:            uuidToString(row.ID),
			Title:         row.Title,
			Status:        row.Status,
			UpdatedAt:     timestampToString(row.UpdatedAt),
			DraftChange:   kb.DraftChange(row.Op),
			ChangedBlocks: kb.ChangedBlockCount(mainBlocks, draftBlocks),
			Origin:        kbDraftOrigin(row),
		})
	}

	return drafts, nil
}

// kbDraftOrigin names where a draft was started: the job's chat, the issue
// or chat of the task that created it, or nothing known.
func kbDraftOrigin(row db.ListKbUserDraftsForPageRow) KbDraftOriginResponse {
	switch {
	case row.JobName.Valid:
		return KbDraftOriginResponse{Type: kbOriginJob, Label: row.JobName.String, RefID: uuidToString(row.ChatSessionID)}
	case row.IssueNumber > 0:
		return KbDraftOriginResponse{Type: kbOriginIssue, Label: row.IssueTitle, RefID: fmt.Sprintf("%d", row.IssueNumber)}
	case row.ChatSessionID.Valid:
		return KbDraftOriginResponse{Type: kbOriginChat, Label: row.ChatTitle, RefID: uuidToString(row.ChatSessionID)}
	default:
		return KbDraftOriginResponse{Type: kbOriginNone, Label: row.Title}
	}
}

// kbSourceViews decides which sources the caller can open and attaches the
// raw file behind raw:// sources. Lookups are batched per kind.
func (h *Handler) kbSourceViews(ctx context.Context, base db.KbBase, userID string, sources []kb.Source) ([]KbSourceResponse, error) {
	views := make([]KbSourceResponse, len(sources))
	if len(sources) == 0 {
		return views, nil
	}

	var (
		rawNames     []string
		issueNumbers []int32
		chatIDs      []pgtype.UUID
	)
	for _, source := range sources {
		switch source.Kind {
		case kb.SourceKindRaw:
			if ref, ok := kb.ParseRawURI(source.URI); ok {
				rawNames = append(rawNames, ref.Name)
			}
		case kb.SourceKindTask:
			if number, ok := kb.ParseTaskURI(source.URI); ok {
				issueNumbers = append(issueNumbers, number)
			}
		case kb.SourceKindChat:
			if id, ok := kb.ParseChatURI(source.URI); ok {
				if parsed, err := util.ParseUUID(id); err == nil {
					chatIDs = append(chatIDs, parsed)
				}
			}
		}
	}

	raws, err := h.loadKbRawFiles(ctx, base.ID, rawNames)
	if err != nil {
		return nil, err
	}
	issues, err := h.loadKbExistingIssues(ctx, base.WorkspaceID, issueNumbers)
	if err != nil {
		return nil, err
	}
	chats, err := h.loadKbOwnChats(ctx, base.WorkspaceID, userID, chatIDs)
	if err != nil {
		return nil, err
	}

	for i, source := range sources {
		view := KbSourceResponse{
			ID:      source.ID,
			Kind:    source.Kind,
			URI:     source.URI,
			Title:   source.Title,
			Version: source.Version,
		}
		switch source.Kind {
		case kb.SourceKindRaw:
			if ref, ok := kb.ParseRawURI(source.URI); ok {
				if raw, found := raws[ref.Kind+"/"+ref.Name]; found {
					view.Openable = true
					view.Raw = &KbRawFileResponse{
						ID:          uuidToString(raw.ID),
						Name:        raw.Name,
						ContentType: raw.ContentType,
						Size:        raw.Size,
						UploadedBy:  uuidToString(raw.UploadedBy),
						CreatedAt:   timestampToString(raw.CreatedAt),
						Page:        ref.Page,
					}
				}
			}
		case kb.SourceKindTask:
			number, ok := kb.ParseTaskURI(source.URI)
			_, found := issues[number]
			view.Openable = ok && found
		case kb.SourceKindChat:
			id, _ := kb.ParseChatURI(source.URI)
			_, found := chats[id]
			view.Openable = found
		default:
			view.Openable = source.Kind != kb.SourceKindOther
		}
		views[i] = view
	}

	return views, nil
}

// loadKbBodyRawIDs maps the raw files that links and images of a page body
// point at (kb.RawFileKey) to their ids, for kb.RawLinks.
func (h *Handler) loadKbBodyRawIDs(ctx context.Context, baseID pgtype.UUID, blocks []kb.Block) (map[string]string, error) {
	refs := kb.RawRefsInBlocks(blocks)
	names := make([]string, len(refs))
	for i, ref := range refs {
		names[i] = ref.Name
	}

	raws, err := h.loadKbRawFiles(ctx, baseID, names)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]string, len(raws))
	for key, raw := range raws {
		ids[key] = uuidToString(raw.ID)
	}

	return ids, nil
}

func (h *Handler) loadKbRawFiles(ctx context.Context, baseID pgtype.UUID, names []string) (map[string]db.KbRaw, error) {
	out := map[string]db.KbRaw{}
	if len(names) == 0 {
		return out, nil
	}

	rows, err := h.Queries.ListKbRawByNames(ctx, db.ListKbRawByNamesParams{KnowledgeBaseID: baseID, Names: names})
	if err != nil {
		return nil, errors.Wrapf(err, "list raw files knowledge_base_id=%s", uuidToString(baseID))
	}
	for _, row := range rows {
		out[row.Kind+"/"+row.Name] = row
	}

	return out, nil
}

func (h *Handler) loadKbExistingIssues(ctx context.Context, wsUUID pgtype.UUID, numbers []int32) (map[int32]struct{}, error) {
	out := map[int32]struct{}{}
	if len(numbers) == 0 {
		return out, nil
	}

	rows, err := h.Queries.ListKbIssueNumbers(ctx, db.ListKbIssueNumbersParams{WorkspaceID: wsUUID, Numbers: numbers})
	if err != nil {
		return nil, errors.Wrap(err, "list cited issues")
	}
	for _, number := range rows {
		out[number] = struct{}{}
	}

	return out, nil
}

func (h *Handler) loadKbOwnChats(ctx context.Context, wsUUID pgtype.UUID, userID string, ids []pgtype.UUID) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	userUUID, ok := memberUUID(userID)
	if len(ids) == 0 || !ok {
		return out, nil
	}

	rows, err := h.Queries.ListKbOwnChatSessionIDs(ctx, db.ListKbOwnChatSessionIDsParams{
		WorkspaceID: wsUUID,
		CreatorID:   userUUID,
		Ids:         ids,
	})
	if err != nil {
		return nil, errors.Wrap(err, "list cited chats")
	}
	for _, id := range rows {
		out[uuidToString(id)] = struct{}{}
	}

	return out, nil
}

// kbActor is a merge request author or merger: an agent or a member.
type kbActor struct {
	kind string
	id   pgtype.UUID
}

// kbActorNames holds display names of agents and members by id.
type kbActorNames struct {
	agents  map[string]string
	members map[string]string
}

func (n kbActorNames) name(kind string, id pgtype.UUID) string {
	if kind == kbActorAgent {
		return n.agents[uuidToString(id)]
	}

	return n.members[uuidToString(id)]
}

// loadKbActorNames batch-loads the display names of agents and members.
func (h *Handler) loadKbActorNames(ctx context.Context, wsUUID pgtype.UUID, actors []kbActor) (kbActorNames, error) {
	names := kbActorNames{agents: map[string]string{}, members: map[string]string{}}

	var agentIDs, memberIDs []pgtype.UUID
	for _, actor := range actors {
		if !actor.id.Valid {
			continue
		}
		if actor.kind == kbActorAgent {
			agentIDs = append(agentIDs, actor.id)
		} else {
			memberIDs = append(memberIDs, actor.id)
		}
	}

	if len(agentIDs) > 0 {
		rows, err := h.Queries.ListKbAgentNames(ctx, db.ListKbAgentNamesParams{WorkspaceID: wsUUID, Ids: agentIDs})
		if err != nil {
			return names, errors.Wrap(err, "list agent names")
		}
		for _, row := range rows {
			names.agents[uuidToString(row.ID)] = row.Name
		}
	}

	if len(memberIDs) > 0 {
		rows, err := h.Queries.GetUsersByIDs(ctx, memberIDs)
		if err != nil {
			return names, errors.Wrap(err, "list member names")
		}
		for _, row := range rows {
			names.members[uuidToString(row.ID)] = row.Name
		}
	}

	return names, nil
}

func kbBlocksToResponse(blocks []kb.Block) []KbBlockResponse {
	out := make([]KbBlockResponse, len(blocks))
	for i, block := range blocks {
		out[i] = KbBlockResponse{ID: block.ID, Kind: block.Kind, Content: block.Content}
	}

	return out
}

func kbClaimsToResponse(claims []kb.Claim) []KbClaimResponse {
	out := make([]KbClaimResponse, len(claims))
	for i, claim := range claims {
		out[i] = KbClaimResponse{Key: claim.Key, BlockID: claim.BlockID, Text: claim.Text, CheckedAt: claim.CheckedAt}
	}

	return out
}

func kbIsStale(staleAfter pgtype.Timestamptz) bool {
	return staleAfter.Valid && staleAfter.Time.Before(time.Now())
}

func staleAfterOf(page *db.KbPage) pgtype.Timestamptz {
	if page == nil {
		return pgtype.Timestamptz{}
	}

	return page.StaleAfter
}

// memberUUID parses the caller's user id; requests without a member
// identity have no drafts and own no chats.
func memberUUID(userID string) (pgtype.UUID, bool) {
	id, err := util.ParseUUID(userID)

	return id, err == nil
}

func uuidOrEmpty(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}

	return uuidToString(u)
}

// kbPageRefParam reads the {id} path parameter. A <kb>:/<path> reference
// arrives URL-encoded (its slashes as %2F), so it is unescaped here.
func kbPageRefParam(r *http.Request) string {
	raw := chi.URLParam(r, "id")
	if ref, err := url.PathUnescape(raw); err == nil {
		return ref
	}

	return raw
}
