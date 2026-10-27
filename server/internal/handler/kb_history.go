package handler

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// kbDiffContextLines is how many unchanged lines a diff hunk keeps around
// each change.
const kbDiffContextLines = 3

// KbRevisionResponse is one entry of a page's history.
type KbRevisionResponse struct {
	RevisionID string `json:"revision_id"`
	// MRNumber is nil for the initial revision written at creation.
	MRNumber     *int32 `json:"mr_number"`
	MRTitle      string `json:"mr_title"`
	Source       string `json:"source"`
	AuthorType   string `json:"author_type"`
	AuthorID     string `json:"author_id"`
	AuthorName   string `json:"author_name"`
	MergedBy     string `json:"merged_by"`
	MergedByName string `json:"merged_by_name"`
	// MergedAt is the merge time, or the creation time of the initial
	// revision.
	MergedAt    string `json:"merged_at"`
	Annotations int32  `json:"annotations"`
	Added       int    `json:"added"`
	Deleted     int    `json:"deleted"`
	Current     bool   `json:"current"`
}

// KbRevisionDiffResponse is one revision compared with the one before it.
type KbRevisionDiffResponse struct {
	Revision       KbRevisionResponse `json:"revision"`
	PrevRevisionID string             `json:"prev_revision_id"`
	Hunks          []kb.DiffHunk      `json:"hunks"`
}

// kbPageHistory is a page's revisions with each one's diff against the
// revision before it.
type kbPageHistory struct {
	items []KbRevisionResponse
	diffs map[string][]kb.DiffLine
	prev  map[string]string
}

// ListKbPageHistory lists a page's revisions, newest first, each with the
// merge request that produced it and its line counts.
func (h *Handler) ListKbPageHistory(w http.ResponseWriter, r *http.Request) {
	page, base, ok := h.loadKbHistoryPage(w, r)
	if !ok {
		return
	}

	history, err := h.loadKbPageHistory(r.Context(), base, page)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, history.items)
}

// GetKbRevisionDiff returns the line diff of one revision against the
// revision before it, as Markdown with links shown as paths.
func (h *Handler) GetKbRevisionDiff(w http.ResponseWriter, r *http.Request) {
	page, base, ok := h.loadKbHistoryPage(w, r)
	if !ok {
		return
	}

	history, err := h.loadKbPageHistory(r.Context(), base, page)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	revisionID := chi.URLParam(r, "revisionId")
	for _, item := range history.items {
		if item.RevisionID != revisionID {
			continue
		}

		writeJSON(w, http.StatusOK, KbRevisionDiffResponse{
			Revision:       item,
			PrevRevisionID: history.prev[revisionID],
			Hunks:          kb.Hunks(history.diffs[revisionID], kbDiffContextLines),
		})
		return
	}

	writeError(w, http.StatusNotFound, "revision not found")
}

// loadKbHistoryPage resolves the page of a history request. Deleted pages
// keep their history.
func (h *Handler) loadKbHistoryPage(w http.ResponseWriter, r *http.Request) (db.KbPage, db.KbBase, bool) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbPage{}, db.KbBase{}, false
	}

	base, pageID, ok := h.resolveKbPageRef(w, r, wsUUID, kbPageRefParam(r), nil)
	if !ok {
		return db.KbPage{}, db.KbBase{}, false
	}

	page, err := h.Queries.GetKbPage(r.Context(), db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: pageID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "page not found")
			return db.KbPage{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load page page_id=%s", uuidToString(pageID)))
		return db.KbPage{}, db.KbBase{}, false
	}

	return page, base, true
}

// loadKbPageHistory loads every revision of a page once and diffs each
// against its predecessor; bodies are rendered as Markdown with kb:// links
// shown as paths.
func (h *Handler) loadKbPageHistory(ctx context.Context, base db.KbBase, page db.KbPage) (kbPageHistory, error) {
	rows, err := h.Queries.ListKbPageRevisions(ctx, db.ListKbPageRevisionsParams{KnowledgeBaseID: base.ID, PageID: page.ID})
	if err != nil {
		return kbPageHistory{}, errors.Wrapf(err, "list revisions page_id=%s", uuidToString(page.ID))
	}

	tree, err := h.loadKbTree(ctx, base.ID, nil)
	if err != nil {
		return kbPageHistory{}, err
	}

	texts := make(map[string][]string, len(rows))
	actors := make([]kbActor, 0, 2*len(rows))
	for _, row := range rows {
		id := uuidToString(row.ID)
		if row.Deleted {
			texts[id] = nil
		} else {
			blocks, err := kb.ParseBlocks(row.Blocks)
			if err != nil {
				return kbPageHistory{}, errors.Wrapf(err, "revision_id=%s", id)
			}
			texts[id] = kb.SplitLines(kb.JoinBlocks(kb.PathLinks(blocks, tree)))
		}
		actors = append(actors,
			kbActor{kind: row.MrAuthorType.String, id: row.MrAuthorID},
			kbActor{kind: kbActorMember, id: row.MrMergedBy},
		)
	}

	names, err := h.loadKbActorNames(ctx, base.WorkspaceID, actors)
	if err != nil {
		return kbPageHistory{}, err
	}

	history := kbPageHistory{
		items: make([]KbRevisionResponse, len(rows)),
		diffs: make(map[string][]kb.DiffLine, len(rows)),
		prev:  make(map[string]string, len(rows)),
	}
	headID := uuidToString(page.HeadRevisionID)
	for i, row := range rows {
		id := uuidToString(row.ID)
		prevID := uuidOrEmpty(row.PrevRevisionID)
		diff := kb.LineDiff(texts[prevID], texts[id])
		stats := kb.Stats(diff)
		history.diffs[id] = diff
		history.prev[id] = prevID

		item := KbRevisionResponse{
			RevisionID:   id,
			MRTitle:      row.MrTitle.String,
			Source:       row.MrSource.String,
			AuthorType:   row.MrAuthorType.String,
			AuthorID:     uuidOrEmpty(row.MrAuthorID),
			AuthorName:   names.name(row.MrAuthorType.String, row.MrAuthorID),
			MergedBy:     uuidOrEmpty(row.MrMergedBy),
			MergedByName: names.name(kbActorMember, row.MrMergedBy),
			MergedAt:     timestampToString(row.CreatedAt),
			Annotations:  row.MrAnnotationCount,
			Added:        stats.Added,
			Deleted:      stats.Deleted,
			Current:      id == headID,
		}
		if row.MrNumber.Valid {
			number := row.MrNumber.Int32
			item.MRNumber = &number
		}
		if row.MrMergedAt.Valid {
			item.MergedAt = timestampToString(row.MrMergedAt)
		}
		history.items[i] = item
	}

	return history, nil
}
