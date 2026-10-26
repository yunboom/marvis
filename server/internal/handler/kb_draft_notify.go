package handler

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbDraftEventWindow is how long kb.draft.updated waits to fold the writes
// of one draft into a single event (spec 9: merged within one second). An
// agent writes page after page; the job page refetches once per window
// instead of once per write.
const kbDraftEventWindow = time.Second

// kbDraftNotifier coalesces kb.draft.updated per draft. The first write of a
// draft opens a window; later writes in it add their pages and raise the
// version; the event goes out when the window closes. The zero value is
// ready to use.
type kbDraftNotifier struct {
	mu      sync.Mutex
	pending map[string]*kbDraftUpdate
	// window overrides kbDraftEventWindow; a test seam.
	window time.Duration
}

// kbDraftUpdate is the pending event of one draft.
type kbDraftUpdate struct {
	workspaceID string
	actorType   string
	actorID     string
	draftID     string
	baseID      string
	jobID       string
	version     int64
	pageIDs     map[string]struct{}
}

// add folds a write into the draft's pending event and reports whether it
// opened a new window (the caller then schedules the flush).
func (n *kbDraftNotifier) add(u kbDraftUpdate, pageIDs []string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.pending == nil {
		n.pending = make(map[string]*kbDraftUpdate)
	}
	current, open := n.pending[u.draftID]
	if !open {
		u.pageIDs = make(map[string]struct{}, len(pageIDs))
		current = &u
		n.pending[u.draftID] = current
	}
	current.version = max(current.version, u.version)
	for _, id := range pageIDs {
		current.pageIDs[id] = struct{}{}
	}

	return !open
}

// take removes and returns the draft's pending event.
func (n *kbDraftNotifier) take(draftID string) *kbDraftUpdate {
	n.mu.Lock()
	defer n.mu.Unlock()

	u := n.pending[draftID]
	delete(n.pending, draftID)

	return u
}

func (n *kbDraftNotifier) delay() time.Duration {
	if n.window > 0 {
		return n.window
	}

	return kbDraftEventWindow
}

// kbDraftUpdatedPayload is the payload of kb.draft.updated.
func kbDraftUpdatedPayload(u *kbDraftUpdate) map[string]any {
	pageIDs := make([]string, 0, len(u.pageIDs))
	for id := range u.pageIDs {
		pageIDs = append(pageIDs, id)
	}
	sort.Strings(pageIDs)

	var jobID any
	if u.jobID != "" {
		jobID = u.jobID
	}

	return map[string]any{
		"draft_id":          u.draftID,
		"job_id":            jobID,
		"knowledge_base_id": u.baseID,
		"version":           u.version,
		"page_ids":          pageIDs,
	}
}

// notifyKbDraftWrite schedules kb.draft.updated for a committed write by the
// request's caller; version is the d<n> the write returned.
func (h *Handler) notifyKbDraftWrite(r *http.Request, draft db.KbDraft, version string, pageIDs ...string) {
	n, err := strconv.ParseInt(strings.TrimPrefix(version, draftVersionPrefix), 10, 64)
	if err != nil {
		n = draft.Version
	}

	actorType, actorID := h.resolveActor(r, requestUserID(r), uuidToString(draft.WorkspaceID))
	h.notifyKbDraftUpdated(r.Context(), draft, n, actorType, actorID, pageIDs...)
}

// notifyKbDraftUpdated schedules kb.draft.updated after a committed draft
// write. Failing to find the draft's job only drops job_id from the event;
// the write itself already succeeded.
func (h *Handler) notifyKbDraftUpdated(ctx context.Context, draft db.KbDraft, version int64, actorType, actorID string, pageIDs ...string) {
	if h.kbDraftEvents == nil {
		return
	}

	jobID := ""
	job, err := h.Queries.GetKbJobByDraft(ctx, draft.ID)
	switch {
	case err == nil:
		jobID = uuidToString(job.ID)
	case !isNotFound(err):
		slog.Warn("kb draft event: job lookup failed", "draft_id", uuidToString(draft.ID), "error", errors.WithStack(err))
	}

	update := kbDraftUpdate{
		workspaceID: uuidToString(draft.WorkspaceID),
		actorType:   actorType,
		actorID:     actorID,
		draftID:     uuidToString(draft.ID),
		baseID:      uuidToString(draft.KnowledgeBaseID),
		jobID:       jobID,
		version:     version,
	}
	if !h.kbDraftEvents.add(update, pageIDs) {
		return
	}

	time.AfterFunc(h.kbDraftEvents.delay(), func() {
		u := h.kbDraftEvents.take(update.draftID)
		if u == nil {
			return
		}
		h.publish(protocol.EventKbDraftUpdated, u.workspaceID, u.actorType, u.actorID, kbDraftUpdatedPayload(u))
	})
}
