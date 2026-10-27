package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Limits on annotation text, in characters.
const (
	kbAnnotationBodyMaxRunes  = 10000
	kbAnnotationQuoteMaxRunes = 1000
)

// kbAnnotationStatusAll lists annotations in every status.
const kbAnnotationStatusAll = "all"

// kbAnnotationBaseLevelPage selects annotations on the whole knowledge base
// in the list's page filter.
const kbAnnotationBaseLevelPage = "-"

// Error codes of the annotation endpoints.
const (
	kbCodeQuoteNotFound    = "quote_not_found"
	kbCodeAnnotationLocked = "annotation_locked"
)

// CreateKbAnnotationRequest is POST /api/kb/bases/{kb}/annotations. A page
// is named by page_id (UUID) or page (any page reference, as the CLI
// passes it); neither means the whole knowledge base.
type CreateKbAnnotationRequest struct {
	PageID  string `json:"page_id"`
	Page    string `json:"page"`
	BlockID string `json:"block_id"`
	Quote   string `json:"quote"`
	Prefix  string `json:"prefix"`
	Suffix  string `json:"suffix"`
	Body    string `json:"body"`
}

// UpdateKbAnnotationRequest is PATCH /api/kb/annotations/{id}.
type UpdateKbAnnotationRequest struct {
	Status string `json:"status"`
}

// KbAnnotationResponse is one annotation (spec 7.6).
type KbAnnotationResponse struct {
	ID              string  `json:"id"`
	KnowledgeBaseID string  `json:"knowledge_base_id"`
	PageID          *string `json:"page_id"`
	PagePath        string  `json:"page_path"`
	PageTitle       string  `json:"page_title"`
	BlockID         string  `json:"block_id"`
	// BlockIndex is the 1-based position of the block on the page ("第 2
	// 段"), 0 when the annotation is not on a block.
	BlockIndex int    `json:"block_index"`
	Quote      string `json:"quote"`
	// OriginalQuote is the sentence as it read when annotated, set once a
	// merge reworded it; empty while unchanged.
	OriginalQuote  string  `json:"original_quote"`
	Prefix         string  `json:"prefix"`
	Suffix         string  `json:"suffix"`
	Body           string  `json:"body"`
	AuthorType     string  `json:"author_type"`
	AuthorID       string  `json:"author_id"`
	AuthorName     string  `json:"author_name"`
	Status         string  `json:"status"`
	AnchorLost     bool    `json:"anchor_lost"`
	MergeRequestID *string `json:"merge_request_id"`
	MRNumber       *int32  `json:"mr_number"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	// Mention is pasted into a reply to render the annotation card.
	Mention string `json:"mention"`
}

// kbAnnotationEvent is the payload of kb.annotation.changed.
type kbAnnotationEvent struct {
	KnowledgeBaseID string   `json:"knowledge_base_id"`
	AnnotationIDs   []string `json:"annotation_ids"`
	PageIDs         []string `json:"page_ids"`
}

// CreateKbAnnotation records an annotation on a sentence, a page or the
// whole knowledge base.
func (h *Handler) CreateKbAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		h.writeKbError(w, r, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "body is required"))
		return
	}
	if utf8.RuneCountInString(body) > kbAnnotationBodyMaxRunes || utf8.RuneCountInString(req.Quote) > kbAnnotationQuoteMaxRunes {
		h.writeKbError(w, r, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "body or quote is too long"))
		return
	}

	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	params, err := h.kbAnnotationTarget(ctx, base, req)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	params.Body = body
	params.AuthorType = actorType
	params.AuthorID = parseUUID(actorID)

	created, err := h.Queries.CreateKbAnnotation(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create annotation knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	views, err := h.kbAnnotationViews(ctx, base, []db.KbAnnotation{created})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	h.publishKbAnnotationChanged(base, actorType, actorID, []db.KbAnnotation{created})
	writeJSON(w, http.StatusCreated, views[0])
}

// kbAnnotationTarget validates what an annotation is attached to and fills
// the location columns of the insert.
func (h *Handler) kbAnnotationTarget(ctx context.Context, base db.KbBase, req CreateKbAnnotationRequest) (db.CreateKbAnnotationParams, error) {
	params := db.CreateKbAnnotationParams{WorkspaceID: base.WorkspaceID, KnowledgeBaseID: base.ID}
	pageRef := strings.TrimSpace(req.PageID)
	if pageRef == "" {
		pageRef = strings.TrimSpace(req.Page)
	}
	quote := kb.NormalizeQuote(req.Quote)

	if pageRef == "" {
		if quote != "" || req.BlockID != "" {
			return params, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "quote and block_id need a page")
		}
		return params, nil
	}
	if (quote == "") != (req.BlockID == "") {
		return params, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "a sentence annotation needs both block_id and quote")
	}

	page, err := h.kbAnnotationPage(ctx, base, pageRef)
	if err != nil {
		return params, err
	}
	params.PageID = page.ID
	if quote == "" {
		return params, nil
	}

	var blocks []kb.Block
	if err := json.Unmarshal(page.Blocks, &blocks); err != nil {
		return params, errors.Wrapf(err, "decode blocks page_id=%s", uuidToString(page.ID))
	}
	anchor, err := kb.LocateQuote(blocks, req.BlockID, quote, req.Prefix, req.Suffix)
	switch {
	case errors.Is(err, kb.ErrBlockNotFound):
		return params, kbFail(http.StatusBadRequest, kbCodeBlockNotFound, "block "+req.BlockID+" is not on the page")
	case errors.Is(err, kb.ErrQuoteNotFound):
		return params, kbFail(http.StatusBadRequest, kbCodeQuoteNotFound, "quote is not in block "+req.BlockID)
	case err != nil:
		return params, err
	}
	params.BlockID = anchor.BlockID
	params.Quote = anchor.Quote
	params.Prefix = anchor.Prefix
	params.Suffix = anchor.Suffix

	return params, nil
}

// kbAnnotationPage resolves a page reference to a live mainline page of the
// knowledge base; anything else is a 400 (spec 7.6).
func (h *Handler) kbAnnotationPage(ctx context.Context, base db.KbBase, ref string) (db.KbPage, error) {
	parsed := kb.ParsePageRef(ref)
	if parsed.KbSlug != "" && parsed.KbSlug != base.Slug && parsed.KbSlug != uuidToString(base.ID) {
		return db.KbPage{}, kbFail(http.StatusBadRequest, kbCodePageNotFound, "page is not in this knowledge base")
	}

	pageID := parsed.PageID
	if pageID == "" {
		tree, err := h.loadKbTree(ctx, base.ID, nil)
		if err != nil {
			return db.KbPage{}, err
		}
		id, found := tree.PageIDByPath(parsed.Path)
		if !found {
			return db.KbPage{}, kbFail(http.StatusBadRequest, kbCodePageNotFound, "page is not in this knowledge base")
		}
		pageID = id
	}

	id, err := util.ParseUUID(pageID)
	if err != nil {
		return db.KbPage{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "invalid page reference")
	}
	page, err := h.Queries.GetKbPage(ctx, db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: id})
	if err != nil {
		if isNotFound(err) {
			return db.KbPage{}, kbFail(http.StatusBadRequest, kbCodePageNotFound, "page is not in this knowledge base")
		}
		return db.KbPage{}, errors.Wrapf(err, "load page page_id=%s", pageID)
	}
	if page.DeletedAt.Valid {
		return db.KbPage{}, kbFail(http.StatusBadRequest, kbCodePageNotFound, "page is deleted")
	}

	return page, nil
}

// ListKbAnnotations lists a knowledge base's annotations, newest first.
// status defaults to pending (all, or one status); page narrows to one page,
// "-" to the whole-knowledge-base ones.
func (h *Handler) ListKbAnnotations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	params := db.ListKbAnnotationsParams{KnowledgeBaseID: base.ID}
	switch status := r.URL.Query().Get("status"); status {
	case "":
		params.Status = pgtype.Text{String: kb.AnnotationStatusPending, Valid: true}
	case kbAnnotationStatusAll:
	case kb.AnnotationStatusPending, kb.AnnotationStatusProcessing, kb.AnnotationStatusResolved, kb.AnnotationStatusDismissed:
		params.Status = pgtype.Text{String: status, Valid: true}
	default:
		h.writeKbError(w, r, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "status must be pending, processing, resolved, dismissed or all"))
		return
	}

	switch pageRef := strings.TrimSpace(r.URL.Query().Get("page")); pageRef {
	case "":
	case kbAnnotationBaseLevelPage:
		params.BaseLevelOnly = true
	default:
		pageID, err := h.kbAnnotationListPage(ctx, base, pageRef)
		if err != nil {
			h.writeKbError(w, r, err)
			return
		}
		params.PageID = pageID
	}

	rows, err := h.Queries.ListKbAnnotations(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list annotations knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	views, err := h.kbAnnotationViews(ctx, base, rows)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, views)
}

// kbAnnotationListPage resolves the list's page filter. Unlike a new
// annotation, a deleted page still filters (its annotations remain).
func (h *Handler) kbAnnotationListPage(ctx context.Context, base db.KbBase, ref string) (pgtype.UUID, error) {
	parsed := kb.ParsePageRef(ref)
	if parsed.PageID != "" {
		id, err := util.ParseUUID(parsed.PageID)
		if err != nil {
			return pgtype.UUID{}, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "invalid page reference")
		}
		return id, nil
	}

	page, err := h.kbAnnotationPage(ctx, base, ref)
	if err != nil {
		var reqErr *kbRequestError
		if errors.As(err, &reqErr) {
			return pgtype.UUID{}, kbFail(http.StatusNotFound, kbCodePageNotFound, "page not found")
		}
		return pgtype.UUID{}, err
	}

	return page.ID, nil
}

// GetKbAnnotation reads one annotation (the annotation card's hover).
func (h *Handler) GetKbAnnotation(w http.ResponseWriter, r *http.Request) {
	annotation, base, ok := h.loadKbAnnotation(w, r)
	if !ok {
		return
	}

	views, err := h.kbAnnotationViews(r.Context(), base, []db.KbAnnotation{annotation})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, views[0])
}

// UpdateKbAnnotation dismisses an annotation or puts a dismissed one back
// to pending. Annotations a merge request is handling or has resolved are
// locked (409).
func (h *Handler) UpdateKbAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req UpdateKbAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Status != kb.AnnotationStatusDismissed && req.Status != kb.AnnotationStatusPending {
		h.writeKbError(w, r, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "status must be dismissed or pending"))
		return
	}

	annotation, base, ok := h.loadKbAnnotation(w, r)
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, uuidToString(base.WorkspaceID))
	if !ok {
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	if !canChangeKbAnnotation(member, base, annotation, actorType, actorID) {
		h.writeKbError(w, r, kbFail(http.StatusForbidden, kbCodeForbidden, "only the author, the knowledge base creator or an owner or admin can change this annotation"))
		return
	}

	updated, changed, err := h.setKbAnnotationStatus(ctx, annotation, req.Status)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	views, err := h.kbAnnotationViews(ctx, base, []db.KbAnnotation{updated})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	if changed {
		h.publishKbAnnotationChanged(base, actorType, actorID, []db.KbAnnotation{updated})
	}
	writeJSON(w, http.StatusOK, views[0])
}

// setKbAnnotationStatus switches between pending and dismissed under a row
// lock so it cannot race a merge request picking the annotation up.
func (h *Handler) setKbAnnotationStatus(ctx context.Context, annotation db.KbAnnotation, status string) (db.KbAnnotation, bool, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return annotation, false, errors.Wrap(err, "begin annotation update")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.GetKbAnnotationForUpdate(ctx, db.GetKbAnnotationForUpdateParams{WorkspaceID: annotation.WorkspaceID, ID: annotation.ID})
	if err != nil {
		return annotation, false, errors.Wrapf(err, "lock annotation annotation_id=%s", uuidToString(annotation.ID))
	}
	if locked.Status == kb.AnnotationStatusProcessing || locked.Status == kb.AnnotationStatusResolved {
		return locked, false, kbFail(http.StatusConflict, kbCodeAnnotationLocked, "annotation is "+locked.Status+" by a merge request")
	}
	if locked.Status == status {
		return locked, false, nil
	}

	updated, err := qtx.SetKbAnnotationStatus(ctx, db.SetKbAnnotationStatusParams{Status: status, WorkspaceID: locked.WorkspaceID, ID: locked.ID})
	if err != nil {
		return locked, false, errors.Wrapf(err, "update annotation annotation_id=%s status=%s", uuidToString(locked.ID), status)
	}
	if err := tx.Commit(ctx); err != nil {
		return locked, false, errors.Wrap(err, "commit annotation update")
	}

	return updated, true, nil
}

// canChangeKbAnnotation: the author (the member, or the agent itself), the
// knowledge base creator, and workspace owners and admins.
func canChangeKbAnnotation(member db.Member, base db.KbBase, annotation db.KbAnnotation, actorType, actorID string) bool {
	if isWorkspaceAdmin(member) || base.CreatedBy == member.UserID {
		return true
	}
	if annotation.AuthorType == kbActorMember {
		return annotation.AuthorID == member.UserID
	}

	return actorType == kbActorAgent && uuidToString(annotation.AuthorID) == actorID
}

// loadKbAnnotation loads {id} in the request's workspace with its knowledge
// base. It writes the error response and returns false when it cannot.
func (h *Handler) loadKbAnnotation(w http.ResponseWriter, r *http.Request) (db.KbAnnotation, db.KbBase, bool) {
	ctx := r.Context()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.KbAnnotation{}, db.KbBase{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return db.KbAnnotation{}, db.KbBase{}, false
	}

	annotation, err := h.Queries.GetKbAnnotationInWorkspace(ctx, db.GetKbAnnotationInWorkspaceParams{WorkspaceID: wsUUID, ID: id})
	if err != nil {
		if isNotFound(err) {
			h.writeKbError(w, r, kbFail(http.StatusNotFound, kbCodeAnnotationNotFound, "annotation not found"))
			return db.KbAnnotation{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load annotation annotation_id=%s", uuidToString(id)))
		return db.KbAnnotation{}, db.KbBase{}, false
	}

	base, err := h.Queries.GetKbBaseByID(ctx, db.GetKbBaseByIDParams{WorkspaceID: wsUUID, ID: annotation.KnowledgeBaseID})
	if err != nil {
		if isNotFound(err) {
			h.writeKbError(w, r, kbFail(http.StatusNotFound, kbCodeAnnotationNotFound, "annotation not found"))
			return db.KbAnnotation{}, db.KbBase{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base of annotation annotation_id=%s", uuidToString(id)))
		return db.KbAnnotation{}, db.KbBase{}, false
	}

	return annotation, base, true
}

// kbAnnotationViews renders annotations with page paths, titles, block
// positions, author names and merge request numbers, each loaded in one
// batch.
func (h *Handler) kbAnnotationViews(ctx context.Context, base db.KbBase, rows []db.KbAnnotation) ([]KbAnnotationResponse, error) {
	out := make([]KbAnnotationResponse, len(rows))
	if len(rows) == 0 {
		return out, nil
	}

	var (
		pageIDs []pgtype.UUID
		mrIDs   []pgtype.UUID
		actors  []kbActor
	)
	for _, row := range rows {
		if row.PageID.Valid {
			pageIDs = append(pageIDs, row.PageID)
		}
		if row.MergeRequestID.Valid {
			mrIDs = append(mrIDs, row.MergeRequestID)
		}
		actors = append(actors, kbActor{kind: row.AuthorType, id: row.AuthorID})
	}

	tree, err := h.loadKbTree(ctx, base.ID, nil)
	if err != nil {
		return nil, err
	}
	pages := map[pgtype.UUID]db.KbPage{}
	if len(pageIDs) > 0 {
		list, err := h.Queries.ListKbPagesByIDs(ctx, db.ListKbPagesByIDsParams{KnowledgeBaseID: base.ID, Ids: pageIDs})
		if err != nil {
			return nil, errors.Wrapf(err, "list annotated pages knowledge_base_id=%s", uuidToString(base.ID))
		}
		for _, page := range list {
			pages[page.ID] = page
		}
	}
	mrNumbers := map[pgtype.UUID]int32{}
	if len(mrIDs) > 0 {
		list, err := h.Queries.ListKbMergeRequestNumbers(ctx, db.ListKbMergeRequestNumbersParams{WorkspaceID: base.WorkspaceID, Ids: mrIDs})
		if err != nil {
			return nil, errors.Wrap(err, "list annotation merge request numbers")
		}
		for _, mr := range list {
			mrNumbers[mr.ID] = mr.Number
		}
	}
	names, err := h.loadKbActorNames(ctx, base.WorkspaceID, actors)
	if err != nil {
		return nil, err
	}

	for i, row := range rows {
		view := KbAnnotationResponse{
			ID:              uuidToString(row.ID),
			KnowledgeBaseID: uuidToString(row.KnowledgeBaseID),
			BlockID:         row.BlockID,
			Quote:           row.Quote,
			OriginalQuote:   row.OriginalQuote,
			Prefix:          row.Prefix,
			Suffix:          row.Suffix,
			Body:            row.Body,
			AuthorType:      row.AuthorType,
			AuthorID:        uuidToString(row.AuthorID),
			AuthorName:      names.name(row.AuthorType, row.AuthorID),
			Status:          row.Status,
			AnchorLost:      kb.AnnotationAnchorLost(row),
			CreatedAt:       timestampToString(row.CreatedAt),
			UpdatedAt:       timestampToString(row.UpdatedAt),
		}
		if row.PageID.Valid {
			pageID := uuidToString(row.PageID)
			view.PageID = &pageID
			view.PagePath, _ = tree.PathByPageID(pageID)
			if page, found := pages[row.PageID]; found {
				view.PageTitle = page.Title
				view.BlockIndex = kbBlockIndex(page.Blocks, row.BlockID)
			}
		}
		if row.MergeRequestID.Valid {
			mrID := uuidToString(row.MergeRequestID)
			view.MergeRequestID = &mrID
			if number, found := mrNumbers[row.MergeRequestID]; found {
				view.MRNumber = &number
			}
		}
		view.Mention = kbAnnotationMention(view)
		out[i] = view
	}

	return out, nil
}

// kbBlockIndex is the 1-based position of a block in stored blocks, 0 when
// it is not there.
func kbBlockIndex(raw []byte, blockID string) int {
	if blockID == "" {
		return 0
	}
	var blocks []kb.Block
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return 0
	}
	for i, block := range blocks {
		if block.ID == blockID {
			return i + 1
		}
	}

	return 0
}

// kbAnnotationMention renders [批注 · <page>](mention://kb_annotation/<id>);
// an annotation on the whole knowledge base is labeled with the label alone.
func kbAnnotationMention(view KbAnnotationResponse) string {
	label := kbAnnotationMentionLabel
	if view.PageTitle != "" {
		label += " · " + view.PageTitle
	}

	return "[" + mentionLabelEscaper.Replace(label) + "](mention://kb_annotation/" + view.ID + ")"
}

// kbAnnotationMentionLabel is the card label of an annotation mention (spec
// 8.1.5 output).
const kbAnnotationMentionLabel = "批注"

// publishKbAnnotationChanged tells clients to refetch annotation lists,
// counts and page annotation panels (spec 9).
func (h *Handler) publishKbAnnotationChanged(base db.KbBase, actorType, actorID string, rows []db.KbAnnotation) {
	payload := kbAnnotationEvent{KnowledgeBaseID: uuidToString(base.ID), AnnotationIDs: []string{}, PageIDs: []string{}}
	for _, row := range rows {
		payload.AnnotationIDs = append(payload.AnnotationIDs, uuidToString(row.ID))
		if row.PageID.Valid {
			payload.PageIDs = append(payload.PageIDs, uuidToString(row.PageID))
		}
	}

	h.publish(protocol.EventKbAnnotationChanged, uuidToString(base.WorkspaceID), actorType, actorID, payload)
}
