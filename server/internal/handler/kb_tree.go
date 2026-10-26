package handler

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// KbTreeParentResponse is the page whose children a tree level lists.
type KbTreeParentResponse struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

// KbTreePageResponse is one page of a tree level.
type KbTreePageResponse struct {
	ID              string `json:"id"`
	Path            string `json:"path"`
	Title           string `json:"title"`
	Type            string `json:"type"`
	Description     string `json:"description"`
	HasChild        bool   `json:"has_child"`
	ChildCount      int64  `json:"child_count"`
	Stale           bool   `json:"stale"`
	OpenAnnotations int64  `json:"open_annotations"`
	DraftChange     string `json:"draft_change"`
}

// KbTreeLevelResponse is one page of one tree level (GET
// /api/kb/bases/{kb}/pages).
type KbTreeLevelResponse struct {
	Version    int64                 `json:"version"`
	Parent     *KbTreeParentResponse `json:"parent"`
	Pages      []KbTreePageResponse  `json:"pages"`
	NextCursor string                `json:"next_cursor"`
}

// kbLevelEntry is a tree level entry with the fields the response needs,
// from the mainline row or a draft copy.
type kbLevelEntry struct {
	kb.LevelPage
	title       string
	pageType    string
	description string
	stale       bool
}

// ListKbPages lists one level of the page tree: the children of ?parent (top
// level when absent), keyset-paginated by (position, id). ?draft overlays the
// caller's draft: pages it adds, edits, moves or deletes carry draft_change.
func (h *Handler) ListKbPages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()

	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	limit, ok := parseKbPageLimit(w, query.Get("limit"))
	if !ok {
		return
	}
	cursor, hasCursor, err := kb.DecodeCursor(query.Get("cursor"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cursor")
		return
	}

	var draft *db.KbDraft
	if param := query.Get("draft"); param != "" {
		d, ok := h.loadKbDraftForReader(w, r, base.WorkspaceID, param)
		if !ok {
			return
		}
		if d.KnowledgeBaseID != base.ID {
			writeError(w, http.StatusNotFound, "draft not found")
			return
		}
		draft = &d
	}

	tree, err := h.loadKbTree(ctx, base.ID, draft)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	parent, ok := h.resolveKbTreeParent(w, r, base, tree, query.Get("parent"))
	if !ok {
		return
	}

	var cursorPtr *kb.PageCursor
	if hasCursor {
		cursorPtr = &cursor
	}
	entries, hasMore, placements, err := h.loadKbLevel(ctx, base, draft, parent, cursorPtr, limit)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	pages, err := h.kbLevelToResponse(ctx, base, tree, entries, placements)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	resp := KbTreeLevelResponse{Version: base.ContentVersion, Parent: parent, Pages: pages}
	if hasMore && len(entries) > 0 {
		last := entries[len(entries)-1]
		resp.NextCursor = kb.EncodeCursor(kb.PageCursor{Position: last.Position, ID: last.ID})
	}

	writeJSON(w, http.StatusOK, resp)
}

func parseKbPageLimit(w http.ResponseWriter, raw string) (int, bool) {
	if raw == "" {
		return kb.DefaultPageListLimit, true
	}

	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > kb.MaxPageListLimit {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
		return 0, false
	}

	return limit, true
}

// resolveKbTreeParent resolves ?parent (a page id, <kb>:/<path> or /<path>)
// to the parent page; nil means the top level.
func (h *Handler) resolveKbTreeParent(w http.ResponseWriter, r *http.Request, base db.KbBase, tree *kb.PageTree, raw string) (*KbTreeParentResponse, bool) {
	if raw == "" {
		return nil, true
	}

	ref := kb.ParsePageRef(raw)
	id := ref.PageID
	if id == "" {
		if ref.KbSlug != "" && ref.KbSlug != base.Slug && ref.KbSlug != uuidToString(base.ID) {
			writeError(w, http.StatusBadRequest, "parent belongs to another knowledge base")
			return nil, false
		}
		if ref.Path == "/" {
			return nil, true
		}

		found := false
		id, found = tree.PageIDByPath(ref.Path)
		if !found {
			writeError(w, http.StatusNotFound, "parent page not found")
			return nil, false
		}
	}

	node, found := tree.Node(id)
	if !found {
		if _, ok := parseUUIDOrBadRequest(w, id, "parent"); !ok {
			return nil, false
		}
		writeError(w, http.StatusNotFound, "parent page not found")
		return nil, false
	}
	path, _ := tree.PathByPageID(id)

	return &KbTreeParentResponse{ID: node.ID, Path: path, Title: node.Title}, true
}

// loadKbLevel loads one page of a tree level with the draft laid over it.
func (h *Handler) loadKbLevel(ctx context.Context, base db.KbBase, draft *db.KbDraft, parent *KbTreeParentResponse, cursor *kb.PageCursor, limit int) ([]kbLevelEntry, bool, []kb.DraftPlacement, error) {
	parentID := pgtype.UUID{}
	parentText := ""
	if parent != nil {
		parentID = parseUUID(parent.ID)
		parentText = parent.ID
	}

	byID := map[string]kbLevelEntry{}
	excluded := make([]pgtype.UUID, 0)
	draftLevel := make([]kb.LevelPage, 0)
	placements := make([]kb.DraftPlacement, 0)

	if draft != nil {
		rows, err := h.Queries.ListKbDraftPages(ctx, db.ListKbDraftPagesParams{KnowledgeBaseID: base.ID, DraftID: draft.ID})
		if err != nil {
			return nil, false, nil, errors.Wrapf(err, "list draft pages draft_id=%s", uuidToString(draft.ID))
		}

		for _, row := range rows {
			id := uuidToString(row.PageID)
			placements = append(placements, kb.DraftPlacement{
				PageID:       id,
				ParentID:     uuidOrEmpty(row.ParentID),
				MainParentID: uuidOrEmpty(row.MainParentID),
				OnMainline:   row.OnMainline,
			})
			if row.OnMainline {
				excluded = append(excluded, row.PageID)
			}
			if uuidOrEmpty(row.ParentID) != parentText {
				continue
			}

			_, header, err := kb.ParseFrontmatter(row.Frontmatter)
			if err != nil {
				return nil, false, nil, errors.Wrapf(err, "draft page page_id=%s", id)
			}
			level := kb.LevelPage{ID: id, Position: row.Position, DraftChange: kb.DraftChange(row.Op)}
			draftLevel = append(draftLevel, level)
			byID[id] = kbLevelEntry{
				LevelPage:   level,
				title:       header.Title,
				pageType:    header.Type,
				description: header.Description,
				stale:       kbIsStale(row.MainStaleAfter),
			}
		}
	}

	params := db.ListKbChildPagesParams{
		KnowledgeBaseID: base.ID,
		ParentID:        parentID,
		ExcludeIds:      excluded,
		RowLimit:        int32(limit + 1),
	}
	if cursor != nil {
		params.AfterPosition = pgtype.Text{String: cursor.Position, Valid: true}
		params.AfterID = parseUUID(cursor.ID)
	}
	rows, err := h.Queries.ListKbChildPages(ctx, params)
	if err != nil {
		return nil, false, nil, errors.Wrapf(err, "list child pages knowledge_base_id=%s parent_id=%s", uuidToString(base.ID), parentText)
	}

	mainLevel := make([]kb.LevelPage, len(rows))
	for i, row := range rows {
		id := uuidToString(row.ID)
		mainLevel[i] = kb.LevelPage{ID: id, Position: row.Position}
		byID[id] = kbLevelEntry{
			LevelPage:   mainLevel[i],
			title:       row.Title,
			pageType:    row.Type,
			description: row.Description,
			stale:       kbIsStale(row.StaleAfter),
		}
	}

	level, hasMore := kb.MergeLevel(mainLevel, draftLevel, cursor, limit)
	entries := make([]kbLevelEntry, len(level))
	for i, page := range level {
		entries[i] = byID[page.ID]
	}

	return entries, hasMore, placements, nil
}

// kbLevelToResponse adds paths, child counts and open annotations, each
// loaded in one batch for the whole level.
func (h *Handler) kbLevelToResponse(ctx context.Context, base db.KbBase, tree *kb.PageTree, entries []kbLevelEntry, placements []kb.DraftPlacement) ([]KbTreePageResponse, error) {
	pages := make([]KbTreePageResponse, len(entries))
	if len(entries) == 0 {
		return pages, nil
	}

	ids := make([]string, len(entries))
	uuids := make([]pgtype.UUID, len(entries))
	for i, entry := range entries {
		ids[i] = entry.ID
		uuids[i] = parseUUID(entry.ID)
	}

	childRows, err := h.Queries.CountKbChildPagesByParent(ctx, db.CountKbChildPagesByParentParams{KnowledgeBaseID: base.ID, ParentIds: uuids})
	if err != nil {
		return nil, errors.Wrapf(err, "count child pages knowledge_base_id=%s", uuidToString(base.ID))
	}
	mainCounts := make(map[string]int64, len(childRows))
	for _, row := range childRows {
		mainCounts[uuidToString(row.ParentID)] = row.ChildCount
	}
	counts := kb.ChildCounts(ids, mainCounts, placements)

	annotationRows, err := h.Queries.CountKbAnnotationsByPage(ctx, db.CountKbAnnotationsByPageParams{
		KnowledgeBaseID: base.ID,
		PageIds:         uuids,
		Status:          kb.AnnotationStatusPending,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "count page annotations knowledge_base_id=%s", uuidToString(base.ID))
	}
	annotations := make(map[string]int64, len(annotationRows))
	for _, row := range annotationRows {
		annotations[uuidToString(row.PageID)] = row.AnnotationCount
	}

	for i, entry := range entries {
		path, _ := tree.PathByPageID(entry.ID)
		pages[i] = KbTreePageResponse{
			ID:              entry.ID,
			Path:            path,
			Title:           entry.title,
			Type:            entry.pageType,
			Description:     entry.description,
			HasChild:        counts[entry.ID] > 0,
			ChildCount:      counts[entry.ID],
			Stale:           entry.stale,
			OpenAnnotations: annotations[entry.ID],
			DraftChange:     entry.DraftChange,
		}
	}

	return pages, nil
}
