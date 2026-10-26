package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/logger"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// KbPendingResponse counts what is waiting on people in a knowledge base.
type KbPendingResponse struct {
	Annotations int64 `json:"annotations"`
	StalePages  int64 `json:"stale_pages"`
	OpenMRs     int64 `json:"open_mrs"`
}

// KbBaseResponse is a knowledge base in list responses.
type KbBaseResponse struct {
	ID             string            `json:"id"`
	WorkspaceID    string            `json:"workspace_id"`
	Name           string            `json:"name"`
	Slug           string            `json:"slug"`
	Description    string            `json:"description"`
	SchemaMode     string            `json:"schema_mode"`
	CreatedBy      string            `json:"created_by"`
	PageCount      int64             `json:"page_count"`
	ContentVersion int64             `json:"content_version"`
	CreatedAt      string            `json:"created_at"`
	UpdatedAt      string            `json:"updated_at"`
	Pending        KbPendingResponse `json:"pending"`
	// Mention is pasted into a reply to render the knowledge base card.
	Mention string `json:"mention"`
}

// KbBaseDetailResponse is a knowledge base with its purpose and schema text.
type KbBaseDetailResponse struct {
	KbBaseResponse
	Purpose string `json:"purpose"`
	Schema  string `json:"schema"`
}

// kbBaseStats holds the per-knowledge-base counts shown next to it.
type kbBaseStats struct {
	pageCounts      map[string]int64
	annotationCount map[string]int64
	staleCounts     map[string]int64
	openMRCounts    map[string]int64
}

func kbBaseToResponse(base db.KbBase, stats kbBaseStats) KbBaseResponse {
	id := uuidToString(base.ID)

	return KbBaseResponse{
		ID:             id,
		WorkspaceID:    uuidToString(base.WorkspaceID),
		Name:           base.Name,
		Slug:           base.Slug,
		Description:    base.Description,
		SchemaMode:     base.SchemaMode,
		CreatedBy:      uuidToString(base.CreatedBy),
		PageCount:      stats.pageCounts[id],
		ContentVersion: base.ContentVersion,
		CreatedAt:      timestampToString(base.CreatedAt),
		UpdatedAt:      timestampToString(base.UpdatedAt),
		Pending: KbPendingResponse{
			Annotations: stats.annotationCount[id],
			StalePages:  stats.staleCounts[id],
			OpenMRs:     stats.openMRCounts[id],
		},
		Mention: kbMention(base),
	}
}

// ListKbBases lists the knowledge bases of the workspace, most recently
// updated first.
func (h *Handler) ListKbBases(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}

	bases, err := h.Queries.ListKbBases(r.Context(), wsUUID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list knowledge bases workspace_id=%s", uuidToString(wsUUID)))
		return
	}

	stats, err := h.loadKbBaseStats(r.Context(), wsUUID, bases)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	resp := make([]KbBaseResponse, len(bases))
	for i, base := range bases {
		resp[i] = kbBaseToResponse(base, stats)
	}

	writeJSON(w, http.StatusOK, resp)
}

// GetKbBase returns one knowledge base with its purpose and schema; {kb} is
// its id or slug.
func (h *Handler) GetKbBase(w http.ResponseWriter, r *http.Request) {
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	stats, err := h.loadKbBaseStats(r.Context(), base.WorkspaceID, []db.KbBase{base})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, KbBaseDetailResponse{
		KbBaseResponse: kbBaseToResponse(base, stats),
		Purpose:        base.Purpose,
		Schema:         base.Schema,
	})
}

// loadKbBaseForUser resolves a knowledge base reference (UUID or slug) inside
// the request's workspace. It writes the error response and returns false
// when the reference does not resolve.
func (h *Handler) loadKbBaseForUser(w http.ResponseWriter, r *http.Request, ref string) (db.KbBase, bool) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbBase{}, false
	}

	var (
		base db.KbBase
		err  error
	)
	if id, parseErr := util.ParseUUID(ref); parseErr == nil {
		base, err = h.Queries.GetKbBaseByID(r.Context(), db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: id})
	} else {
		base, err = h.Queries.GetKbBaseBySlug(r.Context(), db.GetKbBaseBySlugParams{WorkspaceID: wsUUID, Slug: ref})
	}
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "knowledge base not found")
			return db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base ref=%q", ref))
		return db.KbBase{}, false
	}

	return base, true
}

// loadKbBaseStats batch-loads page counts and pending counts for bases.
func (h *Handler) loadKbBaseStats(ctx context.Context, wsUUID pgtype.UUID, bases []db.KbBase) (kbBaseStats, error) {
	stats := kbBaseStats{
		pageCounts:      map[string]int64{},
		annotationCount: map[string]int64{},
		staleCounts:     map[string]int64{},
		openMRCounts:    map[string]int64{},
	}
	if len(bases) == 0 {
		return stats, nil
	}

	baseIDs := make([]pgtype.UUID, len(bases))
	for i, base := range bases {
		baseIDs[i] = base.ID
	}

	pages, err := h.Queries.CountKbPagesByBase(ctx, baseIDs)
	if err != nil {
		return stats, errors.Wrap(err, "count knowledge base pages")
	}
	for _, row := range pages {
		stats.pageCounts[uuidToString(row.KnowledgeBaseID)] = row.PageCount
	}

	annotations, err := h.Queries.CountKbAnnotationsByBase(ctx, db.CountKbAnnotationsByBaseParams{
		BaseIds: baseIDs,
		Status:  kb.AnnotationStatusPending,
	})
	if err != nil {
		return stats, errors.Wrap(err, "count knowledge base annotations")
	}
	for _, row := range annotations {
		stats.annotationCount[uuidToString(row.KnowledgeBaseID)] = row.AnnotationCount
	}

	stale, err := h.Queries.CountKbStalePagesByBase(ctx, baseIDs)
	if err != nil {
		return stats, errors.Wrap(err, "count knowledge base stale pages")
	}
	for _, row := range stale {
		stats.staleCounts[uuidToString(row.KnowledgeBaseID)] = row.StaleCount
	}

	mrs, err := h.Queries.CountKbMergeRequestsByBase(ctx, db.CountKbMergeRequestsByBaseParams{
		WorkspaceID: wsUUID,
		Status:      kb.MergeRequestStatusOpen,
		BaseIds:     baseIDs,
	})
	if err != nil {
		return stats, errors.Wrap(err, "count knowledge base merge requests")
	}
	for _, row := range mrs {
		stats.openMRCounts[uuidToString(row.KnowledgeBaseID)] = row.MergeRequestCount
	}

	return stats, nil
}

// writeKbInternalError logs an unexpected knowledge base failure with its
// stack and answers 500; handlers are the top of this call chain.
func (h *Handler) writeKbInternalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("knowledge base request failed", append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", err))...)
	writeError(w, http.StatusInternalServerError, "internal error")
}
