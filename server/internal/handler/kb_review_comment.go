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
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbQuoteRunes caps the quoted line a comment stores when the client only
// names the block.
const kbQuoteRunes = 200

// kbChatRoleUser is the role of a member's chat message.
const kbChatRoleUser = "user"

// kbChatStatusActive is a chat that takes new messages.
const kbChatStatusActive = "active"

// Values of the state query parameter of the comment list.
const (
	// kbCommentStatePublished lists the published comments only (default).
	kbCommentStatePublished = "published"
	// kbCommentStateAll adds the comments of the viewer's pending review.
	kbCommentStateAll = "all"
)

// kbCodeReviewRequired rejects a reviewer's comment outside a review.
const kbCodeReviewRequired = "review_required"

// KbMrCommentQuote is the diff line a review comment quotes.
type KbMrCommentQuote struct {
	PageID  string `json:"page_id"`
	BlockID string `json:"block_id"`
	Text    string `json:"text"`
}

// KbMrCommentResponse is one review comment.
type KbMrCommentResponse struct {
	ID             string            `json:"id"`
	MergeRequestID string            `json:"merge_request_id"`
	ParentID       *string           `json:"parent_id"`
	Quote          *KbMrCommentQuote `json:"quote"`
	Body           string            `json:"body"`
	AuthorType     string            `json:"author_type"`
	AuthorID       string            `json:"author_id"`
	AuthorName     string            `json:"author_name"`
	// ReviewID is the review the comment was written in; null for the
	// owner's direct comments.
	ReviewID *string `json:"review_id"`
	// Pending is set on the comments of the viewer's unsubmitted review.
	Pending   bool   `json:"pending"`
	CreatedAt string `json:"created_at"`
}

// CreateKbMrCommentRequest posts a review comment. The quote comes either as
// spec's quote object or, from the CLI, as a page reference and a block id;
// the quoted text is then read from the block.
type CreateKbMrCommentRequest struct {
	ParentID     *string           `json:"parent_id"`
	Quote        *KbMrCommentQuote `json:"quote"`
	QuotePage    string            `json:"quote_page"`
	QuoteBlockID string            `json:"quote_block_id"`
	Body         string            `json:"body"`
}

// ListKbMrComments lists a merge request's review comments, oldest first
// (GET /api/kb/merge-requests/{number}/comments). state=published (default)
// lists what everyone sees; state=all adds the viewer's pending comments.
func (h *Handler) ListKbMrComments(w http.ResponseWriter, r *http.Request) {
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

	_, resp, err := h.kbVisibleComments(ctx, mr, userID, state)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// listKbMrComments reads the published comments, plus those of the pending
// review of pendingReviewer when one is given.
func (h *Handler) listKbMrComments(ctx context.Context, mr db.KbMergeRequest, pendingReviewer pgtype.UUID) ([]db.KbMrComment, error) {
	rows, err := h.Queries.ListKbMrComments(ctx, db.ListKbMrCommentsParams{
		MergeRequestID:    mr.ID,
		SubmittedState:    kb.ReviewStateSubmitted,
		PendingReviewerID: pendingReviewer,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list comments merge_request_id=%s", uuidToString(mr.ID))
	}

	return rows, nil
}

// CreateKbMrComment posts a published comment directly (POST
// /api/kb/merge-requests/{number}/comments). Only the owner of the merge
// request (the member who created its draft, or an agent acting for them)
// may: they reply to review feedback here. Reviewers write their comments
// in a review (decision 107) and get 403 review_required. No agent starts.
func (h *Handler) CreateKbMrComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbMrCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "body is required")
		return
	}

	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	owner, err := kbMergeRequestOwner(ctx, h.Queries, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if uuidToString(owner) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeReviewRequired, "only the owner of the merge request comments directly; start a review to leave feedback")
		return
	}

	workspaceID := uuidToString(base.WorkspaceID)
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	comment, err := h.createKbMrComment(ctx, base, mr, req, pgtype.UUID{}, actorType, actorID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMrCommented(mr, actorType, actorID, comment.ID, pgtype.UUID{})

	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, []db.KbMrComment{comment}, pgtype.UUID{})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp[0])
}

// createKbMrComment validates the parent and quote of a new comment and
// writes it, published when review is empty and pending in that review
// otherwise. Replies go under published comments only.
func (h *Handler) createKbMrComment(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, req CreateKbMrCommentRequest, review pgtype.UUID, actorType, actorID string) (db.KbMrComment, error) {
	published, err := h.listKbMrComments(ctx, mr, pgtype.UUID{})
	if err != nil {
		return db.KbMrComment{}, err
	}
	parentID, err := kbCommentParent(published, req.ParentID)
	if err != nil {
		return db.KbMrComment{}, err
	}
	quote, err := h.kbCommentQuote(ctx, base, mr, req)
	if err != nil {
		return db.KbMrComment{}, err
	}

	params := db.CreateKbMrCommentParams{
		MergeRequestID: mr.ID,
		ReviewID:       review,
		ParentID:       parentID,
		Body:           strings.TrimSpace(req.Body),
		AuthorType:     actorType,
		AuthorID:       parseUUID(actorID),
	}
	if quote != nil {
		params.QuotePageID = parseUUID(quote.PageID)
		params.QuoteBlockID = quote.BlockID
		params.QuoteText = quote.Text
	}
	comment, err := h.Queries.CreateKbMrComment(ctx, params)
	if err != nil {
		return db.KbMrComment{}, errors.Wrapf(err, "create comment merge_request_id=%s", uuidToString(mr.ID))
	}

	return comment, nil
}

// publishKbMrCommented tells clients a merge request's published comments
// changed: a direct comment, or a review that was just submitted.
func (h *Handler) publishKbMrCommented(mr db.KbMergeRequest, actorType, actorID string, commentID, reviewID pgtype.UUID) {
	h.publish(protocol.EventKbMrCommented, uuidToString(mr.WorkspaceID), actorType, actorID, map[string]any{
		"merge_request_id":  uuidToString(mr.ID),
		"number":            mr.Number,
		"knowledge_base_id": uuidToString(mr.KnowledgeBaseID),
		"comment_id":        uuidToPtr(commentID),
		"review_id":         uuidToPtr(reviewID),
	})
}

// kbCommentParent checks a reply's parent and keeps threads one level deep:
// a reply to a reply goes under the thread's first comment.
func kbCommentParent(existing []db.KbMrComment, raw *string) (pgtype.UUID, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return pgtype.UUID{}, nil
	}

	for _, c := range existing {
		if uuidToString(c.ID) != strings.TrimSpace(*raw) {
			continue
		}
		if c.ParentID.Valid {
			return c.ParentID, nil
		}

		return c.ID, nil
	}

	return pgtype.UUID{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "parent_id is not a published comment of this merge request")
}

// kbCommentQuote resolves the quoted line. A page reference resolves through
// the request's draft; a missing text is the block's first line.
func (h *Handler) kbCommentQuote(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, req CreateKbMrCommentRequest) (*KbMrCommentQuote, error) {
	quote := req.Quote
	if quote == nil && req.QuotePage != "" {
		quote = &KbMrCommentQuote{BlockID: req.QuoteBlockID}
	}
	if quote == nil {
		return nil, nil
	}
	if quote.BlockID == "" {
		return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a quote needs block_id")
	}

	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, mr.DraftID)
	if err != nil {
		return nil, err
	}
	pageRef := quote.PageID
	if pageRef == "" {
		pageRef = req.QuotePage
	}
	pageID, root, err := overlay.resolveRef(base, pageRef)
	if err == nil && root {
		err = kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a quote needs a page")
	}
	if err != nil {
		// A page the draft deletes is no longer in the overlay but can still
		// be quoted from the diff.
		if _, deleted := overlay.rows[pageRef]; !deleted {
			return nil, err
		}
		pageID = pageRef
	}
	quote.PageID = pageID

	if strings.TrimSpace(quote.Text) == "" {
		text, err := h.kbQuotedBlockText(ctx, base, overlay, pageID, quote.BlockID)
		if err != nil {
			return nil, err
		}
		quote.Text = text
	}

	return quote, nil
}

func (h *Handler) kbQuotedBlockText(ctx context.Context, base db.KbBase, overlay kbOverlay, pageID, blockID string) (string, error) {
	row, inDraft := overlay.rows[pageID]
	blocks := row.blocks
	if !inDraft {
		page, err := h.Queries.GetKbPage(ctx, db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: parseUUID(pageID)})
		if err != nil {
			if isNotFound(err) {
				return "", kbFail(http.StatusBadRequest, kbCodePageNotFound, "the quoted page is not found")
			}

			return "", errors.Wrapf(err, "load quoted page page_id=%s", pageID)
		}
		if blocks, err = kb.ParseBlocks(page.Blocks); err != nil {
			return "", errors.Wrapf(err, "page_id=%s", pageID)
		}
	}

	for _, b := range blocks {
		if b.ID == blockID {
			line, _, _ := strings.Cut(b.Content, "\n")

			return kbSnippet(line, kbQuoteRunes), nil
		}
	}

	return "", kbFail(http.StatusBadRequest, kbCodeBlockNotFound, "the quoted block is not on the page")
}

// kbMrCommentResponses renders comments with their author names; comments of
// pendingReview are marked pending.
func (h *Handler) kbMrCommentResponses(ctx context.Context, wsUUID pgtype.UUID, rows []db.KbMrComment, pendingReview pgtype.UUID) ([]KbMrCommentResponse, error) {
	actors := make([]kbActor, 0, len(rows))
	for _, c := range rows {
		actors = append(actors, kbActor{kind: c.AuthorType, id: c.AuthorID})
	}
	names, err := h.loadKbActorNames(ctx, wsUUID, actors)
	if err != nil {
		return nil, err
	}

	out := make([]KbMrCommentResponse, len(rows))
	for i, c := range rows {
		resp := KbMrCommentResponse{
			ID:             uuidToString(c.ID),
			MergeRequestID: uuidToString(c.MergeRequestID),
			ParentID:       uuidToPtr(c.ParentID),
			Body:           c.Body,
			AuthorType:     c.AuthorType,
			AuthorID:       uuidToString(c.AuthorID),
			AuthorName:     names.name(c.AuthorType, c.AuthorID),
			ReviewID:       uuidToPtr(c.ReviewID),
			Pending:        pendingReview.Valid && c.ReviewID == pendingReview,
			CreatedAt:      timestampToString(c.CreatedAt),
		}
		if c.QuoteBlockID != "" {
			resp.Quote = &KbMrCommentQuote{PageID: uuidOrEmpty(c.QuotePageID), BlockID: c.QuoteBlockID, Text: c.QuoteText}
		}
		out[i] = resp
	}

	return out, nil
}

// kbMergeRequestOwner is the member a merge request answers to: the one who
// created its draft (for an agent's draft, the member it acts for).
func kbMergeRequestOwner(ctx context.Context, q *db.Queries, mr db.KbMergeRequest) (pgtype.UUID, error) {
	drafts, err := q.ListKbDraftsByIDs(ctx, db.ListKbDraftsByIDsParams{WorkspaceID: mr.WorkspaceID, Ids: []pgtype.UUID{mr.DraftID}})
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "load draft of merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if len(drafts) == 0 {
		return pgtype.UUID{}, errors.Errorf("merge request has no draft merge_request_id=%s", uuidToString(mr.ID))
	}

	return drafts[0].CreatedBy, nil
}
