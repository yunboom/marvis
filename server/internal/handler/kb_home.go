package handler

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// kbRecentLimit is how many recently merged pages the home page lists;
// older merges are in the change log.
const kbRecentLimit = 5

// Agent task states during which a knowledge base job counts as running.
const (
	kbTaskQueued          = "queued"
	kbTaskDispatched      = "dispatched"
	kbTaskRunning         = "running"
	kbTaskWaitingLocalDir = "waiting_local_directory"
)

var kbRunningTaskStatuses = []string{kbTaskQueued, kbTaskDispatched, kbTaskRunning, kbTaskWaitingLocalDir}

// KbHomePendingResponse counts the work waiting on people, for the home page.
type KbHomePendingResponse struct {
	Annotations   int64 `json:"annotations"`
	AgentReported int64 `json:"agent_reported"`
	StalePages    int64 `json:"stale_pages"`
	OpenMRs       int64 `json:"open_mrs"`
	// LatestMR is the newest open merge request, nil when none is open.
	LatestMR *KbMergeRequestRefResponse `json:"latest_mr"`
}

// KbRecentPageResponse is a page changed by a recent merge.
type KbRecentPageResponse struct {
	PageID   string `json:"page_id"`
	Path     string `json:"path"`
	Title    string `json:"title"`
	MRNumber int32  `json:"mr_number"`
	MRTitle  string `json:"mr_title"`
	MergedAt string `json:"merged_at"`
}

// KbHomeResponse is the knowledge base home page (GET
// /api/kb/bases/{kb}/home), an overview: the base, pending work, recent
// merges and running jobs. It embeds no page body.
type KbHomeResponse struct {
	KnowledgeBase KbBaseResponse         `json:"knowledge_base"`
	Pending       KbHomePendingResponse  `json:"pending"`
	Recent        []KbRecentPageResponse `json:"recent"`
	RunningJobs   int64                  `json:"running_jobs"`
}

// GetKbHome returns the home page of a knowledge base in one request.
func (h *Handler) GetKbHome(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	stats, err := h.loadKbBaseStats(ctx, base.WorkspaceID, []db.KbBase{base})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	resp := KbHomeResponse{KnowledgeBase: kbBaseToResponse(base, stats)}

	pending, err := h.loadKbHomePending(ctx, base, resp.KnowledgeBase.Pending)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	resp.Pending = pending

	recent, err := h.loadKbRecentPages(ctx, base)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	resp.Recent = recent

	running, err := h.Queries.CountKbRunningJobs(ctx, db.CountKbRunningJobsParams{KnowledgeBaseID: base.ID, Statuses: kbRunningTaskStatuses})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "count running jobs knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	resp.RunningJobs = running

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) loadKbHomePending(ctx context.Context, base db.KbBase, counts KbPendingResponse) (KbHomePendingResponse, error) {
	pending := KbHomePendingResponse{
		Annotations: counts.Annotations,
		StalePages:  counts.StalePages,
		OpenMRs:     counts.OpenMRs,
	}

	byAuthor, err := h.Queries.CountKbAnnotationsByAuthorType(ctx, db.CountKbAnnotationsByAuthorTypeParams{
		KnowledgeBaseID: base.ID,
		Status:          kb.AnnotationStatusPending,
	})
	if err != nil {
		return pending, errors.Wrapf(err, "count annotations by author knowledge_base_id=%s", uuidToString(base.ID))
	}
	for _, row := range byAuthor {
		if row.AuthorType == kbActorAgent {
			pending.AgentReported = row.AnnotationCount
		}
	}

	latest, err := h.Queries.GetLatestKbMergeRequest(ctx, db.GetLatestKbMergeRequestParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Status:          kb.MergeRequestStatusOpen,
	})
	switch {
	case err == nil:
		pending.LatestMR = &KbMergeRequestRefResponse{Number: latest.Number, Title: latest.Title}
	case !isNotFound(err):
		return pending, errors.Wrapf(err, "load latest merge request knowledge_base_id=%s", uuidToString(base.ID))
	}

	return pending, nil
}

func (h *Handler) loadKbRecentPages(ctx context.Context, base db.KbBase) ([]KbRecentPageResponse, error) {
	rows, err := h.Queries.ListKbRecentMergedPages(ctx, db.ListKbRecentMergedPagesParams{
		KnowledgeBaseID: base.ID,
		Status:          kb.MergeRequestStatusMerged,
		RowLimit:        kbRecentLimit,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list recent pages knowledge_base_id=%s", uuidToString(base.ID))
	}

	recent := make([]KbRecentPageResponse, len(rows))
	if len(rows) == 0 {
		return recent, nil
	}

	tree, err := h.loadKbTree(ctx, base.ID, nil)
	if err != nil {
		return nil, err
	}
	for i, row := range rows {
		id := uuidToString(row.PageID)
		path, _ := tree.PathByPageID(id)
		recent[i] = KbRecentPageResponse{
			PageID:   id,
			Path:     path,
			Title:    row.Title,
			MRNumber: row.Number,
			MRTitle:  row.MrTitle,
			MergedAt: timestampToString(row.MergedAt),
		}
	}

	return recent, nil
}
