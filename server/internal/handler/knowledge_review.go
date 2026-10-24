package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/knowledge"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const knowledgeHistoryLimit = 100

func randomBranch(prefix string) (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", errors.WithStack(err)
	}

	return knowledge.BranchPrefix + prefix + "-" + hex.EncodeToString(b), nil
}

// requireKnowledgeApprover 校验当前请求是 owner / admin 本人（不接受机器凭证）。
func (h *Handler) requireKnowledgeApprover(w http.ResponseWriter, r *http.Request, workspaceID string) (db.Member, bool) {
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return db.Member{}, false
	}
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "change requests are merged by a person")
		return db.Member{}, false
	}

	return member, true
}

// MergeKnowledgeChangeRequest 合并变更请求（POST /api/knowledge/changes/{number}/merge）。
func (h *Handler) MergeKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireKnowledgeApprover(w, r, workspaceID); !ok {
		return
	}
	cr, ok := h.loadChangeRequest(w, r, workspaceID)
	if !ok {
		return
	}
	if cr.Status != changeStatusOpen {
		writeError(w, http.StatusConflict, "change request is not open")
		return
	}
	ctx := r.Context()

	head, err := h.Knowledge.Resolve(ctx, workspaceID, knowledge.BranchRef(cr.Branch))
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	if head != cr.HeadCommit {
		writeError(w, http.StatusConflict, "the branch moved since the change request was last updated; refresh it first")
		return
	}
	message := fmt.Sprintf("Merge #%d: %s", cr.Number, cr.Title)
	commit, conflicts, err := h.Knowledge.Merge(ctx, workspaceID, head, message, h.memberSignature(ctx, userID))
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to merge change request")
		return
	}
	if len(conflicts) > 0 {
		if err := h.Queries.MarkKnowledgeChangeRequestConflict(ctx, db.MarkKnowledgeChangeRequestConflictParams{ID: cr.ID, ConflictFiles: conflicts}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record conflict")
			return
		}
		h.publishKnowledge(workspaceID, "member", userID, knowledgeEventChangeRequest, uuidToString(cr.ID))
		writeJSON(w, http.StatusConflict, map[string]any{"error": "change request conflicts with main", "conflict_files": conflicts})
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record merge")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)
	merged, err := qtx.MarkKnowledgeChangeRequestMerged(ctx, db.MarkKnowledgeChangeRequestMergedParams{
		ID: cr.ID, MergeCommit: pgtype.Text{String: commit, Valid: true}, MergedBy: parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record merge")
		return
	}
	if len(cr.AnnotationIds) > 0 {
		if err := qtx.SetKnowledgeAnnotationsStatusForChange(ctx, db.SetKnowledgeAnnotationsStatusForChangeParams{
			Status: annotationResolved, ChangeRequestID: cr.ID, WorkspaceID: cr.WorkspaceID, Ids: cr.AnnotationIds,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to resolve annotations")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record merge")
		return
	}
	if err := h.Knowledge.DeleteBranch(ctx, workspaceID, cr.Branch); err != nil {
		writeKnowledgeError(w, r, err, "merged, but failed to delete the branch")
		return
	}

	h.publishKnowledge(workspaceID, "member", userID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	writeJSON(w, http.StatusOK, changeRequestToResponse(merged, h.actorNames(ctx, []db.KnowledgeChangeRequest{merged})[uuidToString(merged.AuthorID)]))
}

// CloseKnowledgeChangeRequest 关闭变更请求，关联批注退回待处理（POST /api/knowledge/changes/{number}/close）。
func (h *Handler) CloseKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	cr, ok := h.loadChangeRequest(w, r, workspaceID)
	if !ok {
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	isAuthor := cr.AuthorType == actorType && uuidToString(cr.AuthorID) == actorID
	if !roleAllowed(member.Role, "owner", "admin") && !isAuthor {
		writeError(w, http.StatusForbidden, "only the author or a workspace owner or admin can close this change request")
		return
	}
	if cr.Status != changeStatusOpen {
		writeError(w, http.StatusConflict, "change request is not open")
		return
	}
	ctx := r.Context()

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close change request")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)
	closed, err := qtx.CloseKnowledgeChangeRequest(ctx, cr.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close change request")
		return
	}
	if len(cr.AnnotationIds) > 0 {
		if err := qtx.SetKnowledgeAnnotationsStatusForChange(ctx, db.SetKnowledgeAnnotationsStatusForChangeParams{
			Status: annotationPending, ChangeRequestID: pgtype.UUID{}, WorkspaceID: cr.WorkspaceID, Ids: cr.AnnotationIds,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to release annotations")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close change request")
		return
	}
	if err := h.Knowledge.DeleteBranch(ctx, workspaceID, cr.Branch); err != nil {
		writeKnowledgeError(w, r, err, "closed, but failed to delete the branch")
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	writeJSON(w, http.StatusOK, changeRequestToResponse(closed, h.actorNames(ctx, []db.KnowledgeChangeRequest{closed})[uuidToString(closed.AuthorID)]))
}

// CreateKnowledgeChangeComment 在变更请求的某一行留下评论（POST /api/knowledge/changes/{number}/comments）。
func (h *Handler) CreateKnowledgeChangeComment(w http.ResponseWriter, r *http.Request) {
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
	cr, ok := h.loadChangeRequest(w, r, workspaceID)
	if !ok {
		return
	}
	var req struct {
		Path string `json:"path"`
		Line int    `json:"line"`
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" || req.Path == "" || req.Line < 0 {
		writeError(w, http.StatusBadRequest, "path, line and body are required")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)

	c, err := h.Queries.CreateKnowledgeChangeComment(r.Context(), db.CreateKnowledgeChangeCommentParams{
		ChangeRequestID: cr.ID, Path: req.Path, Line: int32(req.Line), AuthorType: actorType, AuthorID: parseUUID(actorID), Body: req.Body,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to add comment")
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	writeJSON(w, http.StatusCreated, KnowledgeChangeComment{
		ID: uuidToString(c.ID), Path: c.Path, Line: int(c.Line), AuthorType: c.AuthorType, AuthorID: uuidToString(c.AuthorID),
		Body: c.Body, CreatedAt: timestampToString(c.CreatedAt),
	})
}

// SubmitKnowledgeEditRequest 是成员手动编辑一页后的提交。
type SubmitKnowledgeEditRequest struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	BaseCommit string `json:"base_commit"`
	Title      string `json:"title"`
}

// SubmitKnowledgeEdit 把手动编辑提交成变更请求（POST /api/knowledge/edits）。
// 编辑基于打开页面时的提交，主线之后的改动由合并时的冲突检测兜底。
func (h *Handler) SubmitKnowledgeEdit(w http.ResponseWriter, r *http.Request) {
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
	var req SubmitKnowledgeEditRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	slug := knowledge.SlugOf(req.Path)
	if _, err := h.Queries.GetKnowledgeBaseBySlug(r.Context(), db.GetKnowledgeBaseBySlugParams{WorkspaceID: parseUUID(workspaceID), Slug: slug}); err != nil {
		writeError(w, http.StatusBadRequest, "path must be inside a knowledge base")
		return
	}
	ctx := r.Context()
	base := strings.TrimSpace(req.BaseCommit)
	if base == "" {
		head, err := h.Knowledge.Head(ctx, workspaceID)
		if err != nil {
			writeKnowledgeError(w, r, err, "failed to read knowledge repository")
			return
		}
		base = head
	}
	current, err := h.Knowledge.ReadFile(ctx, workspaceID, base, req.Path)
	if err != nil && !errors.Is(err, knowledge.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "base_commit or path is invalid")
		return
	}
	if string(current) == req.Content {
		writeError(w, http.StatusBadRequest, "no changes to submit")
		return
	}

	branch, err := randomBranch("edit")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create branch")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Edit " + req.Path
	}
	if _, err := h.Knowledge.Commit(ctx, workspaceID, knowledge.BranchRef(branch), base, "", title, h.memberSignature(ctx, userID), []knowledge.FileChange{{Path: req.Path, Content: []byte(req.Content)}}); err != nil {
		writeKnowledgeError(w, r, err, "failed to save edit")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	cr, snap, err := h.openChangeRequest(ctx, workspaceID, changeInput{Branch: branch, Title: title, Source: changeSourceEdit, Risk: changeRiskLow}, actorType, actorID)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	writeJSON(w, http.StatusCreated, h.changeDetail(ctx, cr, snap.Files))
}

// ListKnowledgeHistory 列出已合并的变更（GET /api/knowledge/history?limit=）。
func (h *Handler) ListKnowledgeHistory(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	limit := knowledgeHistoryLimit
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v < knowledgeHistoryLimit {
		limit = v
	}

	crs, err := h.Queries.ListMergedKnowledgeChangeRequests(r.Context(), db.ListMergedKnowledgeChangeRequestsParams{WorkspaceID: parseUUID(workspaceID), Limit: int32(limit)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list history")
		return
	}
	names := h.actorNames(r.Context(), crs)
	resp := make([]KnowledgeChangeRequestResponse, len(crs))
	for i, cr := range crs {
		resp[i] = changeRequestToResponse(cr, names[uuidToString(cr.AuthorID)])
	}

	writeJSON(w, http.StatusOK, resp)
}

// RevertKnowledgeChangeRequest 为已合并的变更生成回滚变更请求（POST /api/knowledge/changes/{number}/revert）。
func (h *Handler) RevertKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
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
	cr, ok := h.loadChangeRequest(w, r, workspaceID)
	if !ok {
		return
	}
	if cr.Status != changeStatusMerged || !cr.MergeCommit.Valid {
		writeError(w, http.StatusConflict, "only merged change requests can be reverted")
		return
	}
	ctx := r.Context()
	branch := fmt.Sprintf("%srevert-%d", knowledge.BranchPrefix, cr.Number)
	if existing, err := h.Queries.GetOpenKnowledgeChangeRequestByBranch(ctx, db.GetOpenKnowledgeChangeRequestByBranchParams{WorkspaceID: cr.WorkspaceID, Branch: branch}); err == nil {
		writeJSON(w, http.StatusOK, changeRequestToResponse(existing, ""))
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to look up revert")
		return
	}
	// 之前关闭过的回滚分支已删除；同名分支残留时先清掉。
	if err := h.Knowledge.DeleteBranch(ctx, workspaceID, branch); err != nil {
		writeKnowledgeError(w, r, err, "failed to prepare revert branch")
		return
	}

	title := fmt.Sprintf("Revert #%d: %s", cr.Number, cr.Title)
	_, conflicts, err := h.Knowledge.Revert(ctx, workspaceID, cr.MergeCommit.String, branch, title, h.memberSignature(ctx, userID))
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to revert")
		return
	}
	if len(conflicts) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "later changes touch the same lines; revert by hand", "conflict_files": conflicts})
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	revert, snap, err := h.openChangeRequest(ctx, workspaceID, changeInput{Branch: branch, Title: title, Source: changeSourceRevert, Risk: changeRiskMedium}, actorType, actorID)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(revert.ID))
	writeJSON(w, http.StatusCreated, h.changeDetail(ctx, revert, snap.Files))
}
