package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/knowledge"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const maxAnnotationQuote = 1000

func validAnnotationStatus(s string) bool {
	return s == annotationPending || s == annotationProcessing || s == annotationResolved || s == annotationDismissed
}

// KnowledgeAnnotationResponse 是批注的接口表示。AnchorLost 表示原句在当前页面里找不到了，
// 前端按页面批注展示。
type KnowledgeAnnotationResponse struct {
	ID              string  `json:"id"`
	KnowledgeBaseID string  `json:"knowledge_base_id"`
	PagePath        string  `json:"page_path"`
	PageTitle       string  `json:"page_title"`
	Quote           string  `json:"quote"`
	Body            string  `json:"body"`
	AuthorType      string  `json:"author_type"`
	AuthorID        string  `json:"author_id"`
	AuthorName      string  `json:"author_name"`
	Status          string  `json:"status"`
	ChangeRequestID *string `json:"change_request_id"`
	ChangeNumber    *int    `json:"change_number"`
	AnchorLost      bool    `json:"anchor_lost"`
	CreatedAt       string  `json:"created_at"`
}

// annotationResponses 一次性补齐作者名、页面标题、锚点是否丢失和关联的变更请求编号。
func (h *Handler) annotationResponses(ctx context.Context, workspaceID string, rows []db.KnowledgeAnnotation) ([]KnowledgeAnnotationResponse, error) {
	corpus, err := h.loadKnowledgeCorpus(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	users, agents := []pgtype.UUID{}, []pgtype.UUID{}
	for _, a := range rows {
		if a.AuthorType == actorTypeAgent {
			agents = append(agents, a.AuthorID)
		} else {
			users = append(users, a.AuthorID)
		}
	}
	names := h.lookupActorNames(ctx, users, agents)
	numbers, err := h.changeNumbersByID(ctx, workspaceID, rows)
	if err != nil {
		return nil, err
	}

	out := make([]KnowledgeAnnotationResponse, 0, len(rows))
	for _, a := range rows {
		resp := KnowledgeAnnotationResponse{
			ID: uuidToString(a.ID), KnowledgeBaseID: uuidToString(a.KnowledgeBaseID), PagePath: a.PagePath, Quote: a.Quote, Body: a.Body,
			AuthorType: a.AuthorType, AuthorID: uuidToString(a.AuthorID), AuthorName: names[uuidToString(a.AuthorID)],
			Status: a.Status, ChangeRequestID: uuidToPtr(a.ChangeRequestID), CreatedAt: timestampToString(a.CreatedAt),
		}
		if n, ok := numbers[uuidToString(a.ChangeRequestID)]; ok {
			resp.ChangeNumber = &n
		}
		if page, ok := corpus.Pages[a.PagePath]; ok {
			resp.PageTitle = page.Title
			resp.AnchorLost = a.Quote != "" && !pageContainsQuote(page, a.Quote)
		} else {
			resp.AnchorLost = a.Quote != ""
		}
		out = append(out, resp)
	}

	return out, nil
}

// pageContainsQuote 判断批注原句是否仍在页面正文里（按句子文本比较，忽略脚注与 markdown 链接语法）。
func pageContainsQuote(page *knowledge.Page, quote string) bool {
	quote = strings.TrimSpace(quote)
	for _, sec := range page.Sections {
		for _, para := range sec.Paragraphs {
			var b strings.Builder
			for _, s := range para {
				b.WriteString(s.Text)
			}
			if strings.Contains(b.String(), quote) {
				return true
			}
		}
	}

	return false
}

func (h *Handler) changeNumbersByID(ctx context.Context, workspaceID string, rows []db.KnowledgeAnnotation) (map[string]int, error) {
	out := map[string]int{}
	var ids []pgtype.UUID
	for _, a := range rows {
		if a.ChangeRequestID.Valid {
			ids = append(ids, a.ChangeRequestID)
		}
	}
	if len(ids) == 0 {
		return out, nil
	}

	crs, err := h.Queries.ListKnowledgeChangeNumbersByIDs(ctx, db.ListKnowledgeChangeNumbersByIDsParams{WorkspaceID: parseUUID(workspaceID), Ids: ids})
	if err != nil {
		return nil, errors.Wrapf(err, "list change request numbers workspace_id=%s", workspaceID)
	}
	for _, cr := range crs {
		out[uuidToString(cr.ID)] = int(cr.Number)
	}

	return out, nil
}

// CreateKnowledgeAnnotationRequest 是新建批注的请求体；quote 为空表示页面批注。
type CreateKnowledgeAnnotationRequest struct {
	PagePath string `json:"page_path"`
	Quote    string `json:"quote"`
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
	Body     string `json:"body"`
}

// CreateKnowledgeAnnotation 对页面或其中一句提批注（POST /api/knowledge/bases/{id}/annotations）。
func (h *Handler) CreateKnowledgeAnnotation(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateKnowledgeAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	req.Quote = strings.TrimSpace(req.Quote)
	if req.Body == "" {
		writeError(w, http.StatusBadRequest, "body is required")
		return
	}
	if !strings.HasPrefix(req.PagePath, kb.Slug+"/") {
		writeError(w, http.StatusBadRequest, "page_path must be inside the knowledge base")
		return
	}
	if len([]rune(req.Quote)) > maxAnnotationQuote {
		writeError(w, http.StatusBadRequest, "quote is too long")
		return
	}
	corpus, err := h.loadKnowledgeCorpus(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}
	if _, found := corpus.Pages[req.PagePath]; !found {
		writeError(w, http.StatusBadRequest, "page not found")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)

	a, err := h.Queries.CreateKnowledgeAnnotation(r.Context(), db.CreateKnowledgeAnnotationParams{
		WorkspaceID: kb.WorkspaceID, KnowledgeBaseID: kb.ID, PagePath: req.PagePath, Quote: req.Quote,
		Prefix: req.Prefix, Suffix: req.Suffix, Body: req.Body, AuthorType: actorType, AuthorID: parseUUID(actorID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create annotation")
		return
	}
	resp, err := h.annotationResponses(r.Context(), workspaceID, []db.KnowledgeAnnotation{a})
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load annotation")
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventAnnotation, uuidToString(a.ID))
	writeJSON(w, http.StatusCreated, resp[0])
}

// ListKnowledgeAnnotations 列出知识库的批注（GET /api/knowledge/bases/{id}/annotations?status=&page=）。
func (h *Handler) ListKnowledgeAnnotations(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	params := db.ListKnowledgeAnnotationsParams{KnowledgeBaseID: kb.ID, WorkspaceID: kb.WorkspaceID}
	if s := r.URL.Query().Get("status"); s != "" {
		if !validAnnotationStatus(s) {
			writeError(w, http.StatusBadRequest, "invalid status")
			return
		}
		params.Status = pgtype.Text{String: s, Valid: true}
	}
	if p := r.URL.Query().Get("page"); p != "" {
		params.PagePath = pgtype.Text{String: p, Valid: true}
	}

	rows, err := h.Queries.ListKnowledgeAnnotations(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list annotations")
		return
	}
	resp, err := h.annotationResponses(r.Context(), workspaceID, rows)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load annotations")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// UpdateKnowledgeAnnotation 把批注标为不处理或重新打开（PATCH /api/knowledge/annotations/{annotationId}）。
// 已解决和处理中由变更请求驱动，不能手动设置。
func (h *Handler) UpdateKnowledgeAnnotation(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "annotationId"), "annotation id")
	if !ok {
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || (req.Status != annotationDismissed && req.Status != annotationPending) {
		writeError(w, http.StatusBadRequest, "status must be dismissed or pending")
		return
	}
	current, err := h.Queries.GetKnowledgeAnnotation(r.Context(), db.GetKnowledgeAnnotationParams{ID: id, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "annotation not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load annotation")
		}
		return
	}
	if current.Status == annotationProcessing || current.Status == annotationResolved {
		writeError(w, http.StatusConflict, "annotation is handled by a change request")
		return
	}

	a, err := h.Queries.UpdateKnowledgeAnnotationStatus(r.Context(), db.UpdateKnowledgeAnnotationStatusParams{Status: req.Status, ID: id, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update annotation")
		return
	}
	resp, err := h.annotationResponses(r.Context(), workspaceID, []db.KnowledgeAnnotation{a})
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load annotation")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventAnnotation, uuidToString(a.ID))
	writeJSON(w, http.StatusOK, resp[0])
}
