package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// Entry types of the merge request timeline.
const (
	kbTimelineComment = "comment"
	kbTimelineEvent   = "event"
)

// KbMrEventResponse is one event of a merge request.
type KbMrEventResponse struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	ActorType string          `json:"actor_type"`
	ActorID   string          `json:"actor_id"`
	ActorName string          `json:"actor_name"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

// KbMrTimelineEntry is one comment or event of the timeline; the one that
// matches type is set, the other is null.
type KbMrTimelineEntry struct {
	Type      string               `json:"type"`
	ID        string               `json:"id"`
	CreatedAt string               `json:"created_at"`
	Comment   *KbMrCommentResponse `json:"comment"`
	Event     *KbMrEventResponse   `json:"event"`
}

// kbCommentState reads the state query parameter of the comment list and
// the timeline: published (default) or all.
func kbCommentState(w http.ResponseWriter, r *http.Request) (string, bool) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		return kbCommentStatePublished, true
	}
	if state != kbCommentStatePublished && state != kbCommentStateAll {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "state must be published or all")
		return "", false
	}

	return state, true
}

// kbVisibleComments reads the comments the viewer sees for state: the
// published ones, plus with state=all the viewer's pending review, rendered.
func (h *Handler) kbVisibleComments(ctx context.Context, mr db.KbMergeRequest, userID, state string) ([]db.KbMrComment, []KbMrCommentResponse, error) {
	var reviewer, pending pgtype.UUID
	if state == kbCommentStateAll {
		reviewer = parseUUID(userID)
		review, err := h.Queries.GetKbMrPendingReview(ctx, db.GetKbMrPendingReviewParams{
			MergeRequestID: mr.ID, ReviewerID: reviewer, State: kb.ReviewStatePending,
		})
		if err != nil && !isNotFound(err) {
			return nil, nil, errors.Wrapf(err, "load pending review merge_request_id=%s", uuidToString(mr.ID))
		}
		pending = review.ID
	}

	rows, err := h.listKbMrComments(ctx, mr, reviewer)
	if err != nil {
		return nil, nil, err
	}
	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, rows, pending)
	if err != nil {
		return nil, nil, err
	}

	return rows, resp, nil
}

// ListKbMrTimeline returns a merge request's comments and events merged
// oldest first, like the issue timeline (GET
// /api/kb/merge-requests/{number}/timeline). state is that of the comment
// list.
func (h *Handler) ListKbMrTimeline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	state, ok := kbCommentState(w, r)
	if !ok {
		return
	}
	mr, _, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}

	rows, comments, err := h.kbVisibleComments(ctx, mr, userID, state)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	events, err := h.kbMrEvents(ctx, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, mergeKbMrTimeline(rows, comments, events))
}

// kbMrEventRow is a rendered event with its time for merging.
type kbMrEventRow struct {
	at   pgtype.Timestamptz
	resp KbMrEventResponse
}

// mergeKbMrTimeline interleaves comments and events by time; on a tie the
// event comes first (a review's submit event before its comments).
func mergeKbMrTimeline(rows []db.KbMrComment, comments []KbMrCommentResponse, events []kbMrEventRow) []KbMrTimelineEntry {
	out := make([]KbMrTimelineEntry, 0, len(comments)+len(events))
	i, j := 0, 0
	for i < len(comments) || j < len(events) {
		takeEvent := j < len(events) && (i >= len(comments) || !rows[i].CreatedAt.Time.Before(events[j].at.Time))
		if takeEvent {
			e := events[j].resp
			out = append(out, KbMrTimelineEntry{Type: kbTimelineEvent, ID: e.ID, CreatedAt: e.CreatedAt, Event: &e})
			j++
			continue
		}

		c := comments[i]
		out = append(out, KbMrTimelineEntry{Type: kbTimelineComment, ID: c.ID, CreatedAt: c.CreatedAt, Comment: &c})
		i++
	}

	return out
}

func (h *Handler) kbMrEvents(ctx context.Context, mr db.KbMergeRequest) ([]kbMrEventRow, error) {
	rows, err := h.Queries.ListKbMrEvents(ctx, mr.ID)
	if err != nil {
		return nil, errors.Wrapf(err, "list events merge_request_id=%s", uuidToString(mr.ID))
	}
	actors := make([]kbActor, len(rows))
	for i, e := range rows {
		actors[i] = kbActor{kind: e.ActorType, id: e.ActorID}
	}
	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, actors)
	if err != nil {
		return nil, err
	}

	out := make([]kbMrEventRow, len(rows))
	for i, e := range rows {
		out[i] = kbMrEventRow{at: e.CreatedAt, resp: KbMrEventResponse{
			ID:        uuidToString(e.ID),
			Kind:      e.Kind,
			ActorType: e.ActorType,
			ActorID:   uuidToString(e.ActorID),
			ActorName: names.name(e.ActorType, e.ActorID),
			Payload:   json.RawMessage(e.Payload),
			CreatedAt: timestampToString(e.CreatedAt),
		}}
	}

	return out, nil
}
