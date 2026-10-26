package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// CreateKbDraftPageRequest creates a page inside a draft.
type CreateKbDraftPageRequest struct {
	Parent      string         `json:"parent"`
	After       string         `json:"after"`
	Slug        string         `json:"slug"`
	Frontmatter map[string]any `json:"frontmatter"`
	Content     string         `json:"content"`
}

// KbDraftPageCreatedResponse is a page created in a draft.
type KbDraftPageCreatedResponse struct {
	PageID   string         `json:"page_id"`
	Path     string         `json:"path"`
	Version  string         `json:"version"`
	Blocks   []string       `json:"blocks"`
	Warnings []lint.Finding `json:"warnings"`
	Mention  string         `json:"mention"`
}

// KbPageOp is one operation of an ops request.
type KbPageOp struct {
	Op      string         `json:"op"`
	Block   string         `json:"block"`
	After   string         `json:"after"`
	Content string         `json:"content"`
	Find    string         `json:"find"`
	Replace string         `json:"replace"`
	Fields  map[string]any `json:"fields"`
	// Parent and Slug are for move; After is the sibling page for move and
	// the anchor block for block_move_after.
	Parent string `json:"parent"`
	Slug   string `json:"slug"`
}

// KbPageOpsRequest applies operations to one page of a draft, all or none.
type KbPageOpsRequest struct {
	Version string     `json:"version"`
	Ops     []KbPageOp `json:"ops"`
}

// KbPageOpsResponse is the page after the operations.
type KbPageOpsResponse struct {
	PageID    string         `json:"page_id"`
	Path      string         `json:"path"`
	Version   string         `json:"version"`
	NewBlocks []string       `json:"new_blocks"`
	Warnings  []lint.Finding `json:"warnings"`
}

// PutKbClaimsRequest replaces the claims of one page of a draft.
type PutKbClaimsRequest struct {
	Version string     `json:"version"`
	Claims  []kb.Claim `json:"claims"`
}

// KbHeaderSourceResponse is one entry of a page header's sources list.
type KbHeaderSourceResponse struct {
	ID       string `json:"id"`
	Resource string `json:"resource"`
	Title    string `json:"title"`
}

// PutKbClaimsResponse is the new version and the regenerated sources.
type PutKbClaimsResponse struct {
	PageID   string                   `json:"page_id"`
	Version  string                   `json:"version"`
	Sources  []KbHeaderSourceResponse `json:"sources"`
	Warnings []lint.Finding           `json:"warnings"`
}

// kbRequiredMeta are the header keys a new page must have.
var kbRequiredMeta = []string{kb.MetaType, kb.MetaTitle, kb.MetaDescription}

// beginKbDraftWrite opens the transaction of a draft write and locks the
// draft. The caller must call the returned rollback.
func (h *Handler) beginKbDraftWrite(ctx context.Context, draft db.KbDraft) (*db.Queries, func() error, func(), db.KbDraft, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, func() {}, db.KbDraft{}, errors.Wrap(err, "begin draft write")
	}
	rollback := func() { _ = tx.Rollback(ctx) }
	qtx := h.Queries.WithTx(tx)

	locked, err := lockKbOpenDraft(ctx, qtx, draft)
	if err != nil {
		return nil, nil, rollback, db.KbDraft{}, err
	}

	commit := func() error { return errors.Wrap(tx.Commit(ctx), "commit draft write") }

	return qtx, commit, rollback, locked, nil
}

// CreateKbDraftPage creates a page in a draft (POST
// /api/kb/drafts/{id}/pages).
func (h *Handler) CreateKbDraftPage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	unlocked, base, ok := h.loadKbDraftForWriter(w, r)
	if !ok {
		return
	}

	var req CreateKbDraftPageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateKbNewPage(req); err != nil {
		h.writeKbError(w, r, err)
		return
	}

	q, commit, rollback, draft, err := h.beginKbDraftWrite(ctx, unlocked)
	defer rollback()
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	resp, err := createKbDraftPage(ctx, q, base, draft, req)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if err := commit(); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	h.notifyKbDraftWrite(r, draft, resp.Version, resp.PageID)

	writeJSON(w, http.StatusCreated, resp)
}

func validateKbNewPage(req CreateKbDraftPageRequest) error {
	if strings.TrimSpace(req.Parent) == "" {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "parent is required; use <kb>:/ for the top level")
	}
	if !workspaceSlugPattern.MatchString(req.Slug) {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "slug must contain only lowercase letters, numbers, and hyphens")
	}
	for _, key := range kbRequiredMeta {
		if s, _ := req.Frontmatter[key].(string); strings.TrimSpace(s) == "" {
			return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "frontmatter needs type, title and description")
		}
	}
	for _, key := range []string{kb.MetaSources, kb.MetaGenerated} {
		if _, ok := req.Frontmatter[key]; ok {
			return kbFail(http.StatusBadRequest, kbCodeProtectedMetaKey, "sources and generated are maintained by Marvis")
		}
	}
	if kb.HasConflictMarkers(req.Content) {
		return kbFail(http.StatusConflict, kbCodeConflictMarkers, "content still contains conflict markers")
	}

	return nil
}

func createKbDraftPage(ctx context.Context, q *db.Queries, base db.KbBase, draft db.KbDraft, req CreateKbDraftPageRequest) (KbDraftPageCreatedResponse, error) {
	overlay, err := loadKbOverlay(ctx, q, base.ID, draft.ID)
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}

	parentID, _, err := overlay.resolveRef(base, req.Parent)
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}
	afterID := ""
	if req.After != "" {
		if afterID, _, err = overlay.resolveRef(base, req.After); err != nil {
			return KbDraftPageCreatedResponse{}, err
		}
	}
	if overlay.slugTaken(parentID, req.Slug, "") {
		return KbDraftPageCreatedResponse{}, kbFail(http.StatusConflict, kbCodeDuplicateSlug, "a page under this parent already uses this slug")
	}
	position, err := overlay.positionAfter(parentID, afterID, "")
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}

	usedIDs, err := q.ListKbPageBlockIDs(ctx, base.ID)
	if err != nil {
		return KbDraftPageCreatedResponse{}, errors.Wrapf(err, "list block ids knowledge_base_id=%s", uuidToString(base.ID))
	}
	blocks, err := kb.NewBlocks(req.Content, kb.NewBlockIDAllocator(usedIDs))
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}

	page := kbDraftPage{
		pageID:    uuid.New().String(),
		op:        kb.DraftOpCreate,
		parentID:  parentID,
		position:  position,
		slug:      req.Slug,
		header:    req.Frontmatter,
		claims:    []kb.Claim{},
		conflicts: []kb.Conflict{},
	}
	overlay.place(page)
	page.blocks, _ = kb.ResolveLinks(blocks, overlay.tree)

	version, err := saveKbDraftPage(ctx, q, draft, &page)
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}
	overlay.place(page)

	warnings, err := lintKbDraftPages(ctx, q, base, overlay, []string{page.pageID})
	if err != nil {
		return KbDraftPageCreatedResponse{}, err
	}
	path, _ := overlay.tree.PathByPageID(page.pageID)
	title, _ := page.header[kb.MetaTitle].(string)

	return KbDraftPageCreatedResponse{
		PageID:   page.pageID,
		Path:     path,
		Version:  kbDraftVersion(version),
		Blocks:   blockIDList(page.blocks),
		Warnings: warnings,
		Mention:  pageMention(title, page.pageID),
	}, nil
}

// ApplyKbPageOps applies block, header, move and delete operations to one
// page of a draft (POST /api/kb/drafts/{id}/pages/{ref}/ops). The first
// write to a mainline page copies it into the draft.
func (h *Handler) ApplyKbPageOps(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	unlocked, base, ok := h.loadKbDraftForWriter(w, r)
	if !ok {
		return
	}
	_, pageID, ok := h.resolveKbPageRef(w, r, base.WorkspaceID, kbPageRefParam(r), &unlocked)
	if !ok {
		return
	}

	var req KbPageOpsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Ops) == 0 {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "ops is empty")
		return
	}

	q, commit, rollback, draft, err := h.beginKbDraftWrite(ctx, unlocked)
	defer rollback()
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	page, err := loadKbDraftPage(ctx, q, base, draft, pageID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if err := checkKbPageVersion(page, draft, req.Version); err != nil {
		h.writeKbError(w, r, err)
		return
	}

	resp, err := applyKbPageOps(ctx, q, base, draft, page, req.Ops)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if err := commit(); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	h.notifyKbDraftWrite(r, draft, resp.Version, resp.PageID)

	writeJSON(w, http.StatusOK, resp)
}

// kbOpsState accumulates what a sequence of operations did to a page.
type kbOpsState struct {
	page      kbDraftPage
	newBlocks []string
	content   bool
	moved     bool
	deleted   bool
}

func applyKbPageOps(ctx context.Context, q *db.Queries, base db.KbBase, draft db.KbDraft, page kbDraftPage, ops []KbPageOp) (KbPageOpsResponse, error) {
	overlay, err := loadKbOverlay(ctx, q, base.ID, draft.ID)
	if err != nil {
		return KbPageOpsResponse{}, err
	}
	usedIDs, err := q.ListKbPageBlockIDs(ctx, base.ID)
	if err != nil {
		return KbPageOpsResponse{}, errors.Wrapf(err, "list block ids knowledge_base_id=%s", uuidToString(base.ID))
	}
	ids := kb.NewBlockIDAllocator(usedIDs)

	st := &kbOpsState{page: page, newBlocks: []string{}}
	for _, op := range ops {
		if st.deleted {
			return KbPageOpsResponse{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "no operation can follow delete")
		}
		if err := applyKbPageOp(&overlay, base, st, op, ids); err != nil {
			return KbPageOpsResponse{}, err
		}
	}

	if st.deleted && page.op == kb.DraftOpCreate {
		if err := q.DeleteKbDraftPage(ctx, db.DeleteKbDraftPageParams{DraftID: draft.ID, PageID: parseUUID(page.pageID)}); err != nil {
			return KbPageOpsResponse{}, errors.Wrapf(err, "drop created page page_id=%s", page.pageID)
		}
		bumped, err := q.BumpKbDraftVersion(ctx, draft.ID)
		if err != nil {
			return KbPageOpsResponse{}, errors.Wrapf(err, "bump draft version draft_id=%s", uuidToString(draft.ID))
		}

		return KbPageOpsResponse{PageID: page.pageID, Version: kbDraftVersion(bumped.Version), NewBlocks: []string{}, Warnings: []lint.Finding{}}, nil
	}

	next := st.page
	switch {
	case st.deleted:
		next.op = kb.DraftOpDelete
	case next.op == kb.DraftOpCreate || next.op == kb.DraftOpUpdate:
	case st.content:
		next.op = kb.DraftOpUpdate
	case st.moved:
		next.op = kb.DraftOpMove
	}

	if !st.deleted {
		overlay.place(next)
		next.blocks, _ = kb.ResolveLinks(next.blocks, overlay.tree)
	}
	version, err := saveKbDraftPage(ctx, q, draft, &next)
	if err != nil {
		return KbPageOpsResponse{}, err
	}
	overlay.place(next)

	warnings := []lint.Finding{}
	if !st.deleted {
		if warnings, err = lintKbDraftPages(ctx, q, base, overlay, []string{next.pageID}); err != nil {
			return KbPageOpsResponse{}, err
		}
	}
	path, _ := overlay.tree.PathByPageID(next.pageID)

	return KbPageOpsResponse{
		PageID:    next.pageID,
		Path:      path,
		Version:   kbDraftVersion(version),
		NewBlocks: st.newBlocks,
		Warnings:  warnings,
	}, nil
}

// applyKbPageOp applies one operation to the page in st.
func applyKbPageOp(overlay *kbOverlay, base db.KbBase, st *kbOpsState, op KbPageOp, ids *kb.BlockIDAllocator) error {
	page := &st.page
	if kb.HasConflictMarkers(op.Content) || kb.HasConflictMarkers(op.Replace) {
		return kbFail(http.StatusConflict, kbCodeConflictMarkers, "content still contains conflict markers; write the resolved text")
	}

	var (
		blocks  []kb.Block
		newIDs  []string
		touched string
		err     error
	)
	switch op.Op {
	case kb.OpBlockReplace:
		blocks, newIDs, err = kb.ReplaceBlock(page.blocks, op.Block, op.Content, ids)
		touched = op.Block
	case kb.OpBlockInsertAfter:
		blocks, newIDs, err = kb.InsertBlocksAfter(page.blocks, op.Block, op.Content, ids)
	case kb.OpBlockDelete:
		blocks, err = kb.DeleteBlock(page.blocks, op.Block)
		touched = op.Block
	case kb.OpBlockMoveAfter:
		blocks, err = kb.MoveBlockAfter(page.blocks, op.Block, op.After)
	case kb.OpStrReplace:
		blocks, touched, newIDs, err = kb.StrReplace(page.blocks, op.Find, op.Replace, ids)
	case kb.OpAppend:
		blocks, newIDs, err = kb.AppendBlocks(page.blocks, op.Content, ids)
	case kb.OpSetMeta:
		return applyKbSetMeta(st, op.Fields)
	case kb.OpMove:
		return applyKbMove(overlay, base, st, op)
	case kb.OpDelete:
		if overlay.hasChildren(page.pageID) {
			return kbFail(http.StatusConflict, kbCodePageHasChildren, "move or delete the child pages first")
		}
		st.deleted = true
		page.conflicts = []kb.Conflict{}

		return nil
	default:
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "unknown op "+op.Op)
	}
	if err != nil {
		return kbOpError(err)
	}

	page.blocks = blocks
	st.newBlocks = append(st.newBlocks, newIDs...)
	st.content = true
	page.conflicts = clearKbConflicts(page.conflicts, func(c kb.Conflict) bool {
		return c.Kind == kb.ConflictPage || (c.Kind == kb.ConflictBlock && c.BlockID == touched)
	})

	return nil
}

func applyKbSetMeta(st *kbOpsState, fields map[string]any) error {
	if len(fields) == 0 {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "set_meta needs fields")
	}
	if raw, ok := fields[kb.MetaStaleAfter].(string); ok && raw != "" {
		normalized, err := normalizeKbTime(raw)
		if err != nil {
			return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "stale_after must be a date or an RFC3339 time")
		}
		fields[kb.MetaStaleAfter] = normalized
	}

	header, err := kb.SetMeta(st.page.header, fields)
	if err != nil {
		return kbOpError(err)
	}
	st.page.header = header
	st.content = true
	st.page.conflicts = clearKbConflicts(st.page.conflicts, func(c kb.Conflict) bool {
		_, set := fields[c.Key]

		return c.Kind == kb.ConflictPage || (c.Kind == kb.ConflictMeta && set)
	})

	return nil
}

func applyKbMove(overlay *kbOverlay, base db.KbBase, st *kbOpsState, op KbPageOp) error {
	page := &st.page
	if op.Parent == "" {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "move needs parent; use <kb>:/ for the top level")
	}
	parentID, _, err := overlay.resolveRef(base, op.Parent)
	if err != nil {
		return err
	}
	if parentID == page.pageID || (parentID != "" && overlay.isDescendant(parentID, page.pageID)) {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a page cannot move under itself")
	}

	slug := page.slug
	if op.Slug != "" {
		if !workspaceSlugPattern.MatchString(op.Slug) {
			return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "slug must contain only lowercase letters, numbers, and hyphens")
		}
		slug = op.Slug
	}
	if overlay.slugTaken(parentID, slug, page.pageID) {
		return kbFail(http.StatusConflict, kbCodeDuplicateSlug, "a page under this parent already uses this slug")
	}

	afterID := ""
	if op.After != "" {
		if afterID, _, err = overlay.resolveRef(base, op.After); err != nil {
			return err
		}
	}
	position, err := overlay.positionAfter(parentID, afterID, page.pageID)
	if err != nil {
		return err
	}

	page.parentID = parentID
	page.slug = slug
	page.position = position
	st.moved = true
	page.conflicts = clearKbConflicts(page.conflicts, func(c kb.Conflict) bool { return c.Kind == kb.ConflictMove })
	overlay.place(*page)

	return nil
}

// kbOpError maps block model errors to request errors.
func kbOpError(err error) error {
	switch {
	case errors.Is(err, kb.ErrBlockNotFound):
		return kbFail(http.StatusNotFound, kbCodeBlockNotFound, err.Error())
	case errors.Is(err, kb.ErrStrReplaceMatch):
		return kbFail(http.StatusConflict, kbCodeStrReplaceMatch, "find must occur exactly once on the page")
	case errors.Is(err, kb.ErrEmptyBlockContent):
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "content is empty; use block_delete to remove a block")
	case errors.Is(err, kb.ErrProtectedMeta):
		return kbFail(http.StatusBadRequest, kbCodeProtectedMetaKey, "sources and generated are maintained by Marvis")
	default:
		return err
	}
}

func clearKbConflicts(conflicts []kb.Conflict, resolved func(kb.Conflict) bool) []kb.Conflict {
	out := make([]kb.Conflict, 0, len(conflicts))
	for _, c := range conflicts {
		if !resolved(c) {
			out = append(out, c)
		}
	}

	return out
}

// normalizeKbTime accepts a date (2027-01-20) or an RFC3339 time and returns
// RFC3339 in UTC.
func normalizeKbTime(raw string) (string, error) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC().Format(time.RFC3339), nil
	}
	t, err := time.Parse(time.DateOnly, raw)
	if err != nil {
		return "", errors.WithStack(err)
	}

	return t.UTC().Format(time.RFC3339), nil
}

// PutKbDraftClaims replaces the claims of one page of a draft and
// regenerates its header sources (PUT /api/kb/drafts/{id}/pages/{ref}/claims).
func (h *Handler) PutKbDraftClaims(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	unlocked, base, ok := h.loadKbDraftForWriter(w, r)
	if !ok {
		return
	}
	_, pageID, ok := h.resolveKbPageRef(w, r, base.WorkspaceID, kbPageRefParam(r), &unlocked)
	if !ok {
		return
	}

	var req PutKbClaimsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	claims, err := normalizeKbClaims(req.Claims)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	q, commit, rollback, draft, err := h.beginKbDraftWrite(ctx, unlocked)
	defer rollback()
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	page, err := loadKbDraftPage(ctx, q, base, draft, pageID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if err := checkKbPageVersion(page, draft, req.Version); err != nil {
		h.writeKbError(w, r, err)
		return
	}

	page.claims = claims
	sources := kbSourcesHeader(page.blocks, claims)
	page.header = cloneKbHeader(page.header)
	if len(sources) == 0 {
		delete(page.header, kb.MetaSources)
	} else {
		page.header[kb.MetaSources] = sources
	}
	if page.op == "" {
		page.op = kb.DraftOpUpdate
	}

	version, err := saveKbDraftPage(ctx, q, draft, &page)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	overlay, err := loadKbOverlay(ctx, q, base.ID, draft.ID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	warnings, err := lintKbDraftPages(ctx, q, base, overlay, []string{page.pageID})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if err := commit(); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	h.notifyKbDraftWrite(r, draft, kbDraftVersion(version), page.pageID)

	resp := PutKbClaimsResponse{PageID: page.pageID, Version: kbDraftVersion(version), Sources: []KbHeaderSourceResponse{}, Warnings: warnings}
	for _, s := range sources {
		resp.Sources = append(resp.Sources, KbHeaderSourceResponse{ID: s["id"].(string), Resource: s["resource"].(string), Title: s["title"].(string)})
	}

	writeJSON(w, http.StatusOK, resp)
}

// normalizeKbClaims validates a claims list: unique non-empty keys, a block
// id, and a source id and uri on every evidence. checked_at defaults to now.
func normalizeKbClaims(claims []kb.Claim) ([]kb.Claim, error) {
	out := make([]kb.Claim, 0, len(claims))
	seen := make(map[string]bool, len(claims))
	now := time.Now().UTC().Format(time.RFC3339)

	for _, c := range claims {
		if c.Key == "" || seen[c.Key] {
			return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "every claim needs a unique key")
		}
		seen[c.Key] = true
		if c.BlockID == "" {
			return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "claim "+c.Key+" needs a block_id")
		}
		for _, ev := range c.Evidence {
			if ev.Source == "" || ev.URI == "" {
				return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "every evidence of claim "+c.Key+" needs a source and a uri")
			}
		}
		if c.Evidence == nil {
			c.Evidence = []kb.Evidence{}
		}
		if c.CheckedAt == "" {
			c.CheckedAt = now
		} else if normalized, err := normalizeKbTime(c.CheckedAt); err == nil {
			c.CheckedAt = normalized
		} else {
			return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "checked_at of claim "+c.Key+" must be an RFC3339 time")
		}
		out = append(out, c)
	}

	return out, nil
}

func cloneKbHeader(header map[string]any) map[string]any {
	out := make(map[string]any, len(header)+1)
	for k, v := range header {
		out[k] = v
	}

	return out
}

func blockIDList(blocks []kb.Block) []string {
	out := make([]string, len(blocks))
	for i, block := range blocks {
		out[i] = block.ID
	}

	return out
}
