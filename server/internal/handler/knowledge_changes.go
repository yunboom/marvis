package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/knowledge"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// 变更请求的状态、来源、风险词表（与迁移 604 的约束一致）。
const (
	changeStatusOpen   = "open"
	changeStatusMerged = "merged"
	changeStatusClosed = "closed"

	changeSourceFix    = "fix"
	changeSourceIngest = "ingest"
	changeSourceFresh  = "fresh"
	changeSourceMerge  = "merge"
	changeSourceGap    = "gap"
	changeSourceDigest = "digest"
	changeSourceEdit   = "edit"
	changeSourceRevert = "revert"
	changeSourceAgent  = "agent"

	changeRiskLow    = "low"
	changeRiskMedium = "medium"
	changeRiskHigh   = "high"

	annotationPending    = "pending"
	annotationProcessing = "processing"
	annotationResolved   = "resolved"
	annotationDismissed  = "dismissed"
)

var validChangeSources = map[string]bool{
	changeSourceFix: true, changeSourceIngest: true, changeSourceFresh: true, changeSourceMerge: true, changeSourceGap: true,
	changeSourceDigest: true, changeSourceEdit: true, changeSourceRevert: true, changeSourceAgent: true,
}

var validChangeRisks = map[string]bool{changeRiskLow: true, changeRiskMedium: true, changeRiskHigh: true}

// KnowledgeChangeRequestResponse 是变更请求的接口表示。
type KnowledgeChangeRequestResponse struct {
	ID            string   `json:"id"`
	Number        int      `json:"number"`
	Title         string   `json:"title"`
	Source        string   `json:"source"`
	AuthorType    string   `json:"author_type"`
	AuthorID      string   `json:"author_id"`
	AuthorName    string   `json:"author_name"`
	Branch        string   `json:"branch"`
	BaseCommit    string   `json:"base_commit"`
	HeadCommit    string   `json:"head_commit"`
	Status        string   `json:"status"`
	Conflict      bool     `json:"conflict"`
	ConflictFiles []string `json:"conflict_files"`
	Summary       string   `json:"summary"`
	Risk          string   `json:"risk"`
	MergeCommit   *string  `json:"merge_commit"`
	ChatSessionID *string  `json:"chat_session_id"`
	AnnotationIDs []string `json:"annotation_ids"`
	KBSlugs       []string `json:"kb_slugs"`
	MergedAt      *string  `json:"merged_at"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

func changeRequestToResponse(cr db.KnowledgeChangeRequest, authorName string) KnowledgeChangeRequestResponse {
	ids := make([]string, len(cr.AnnotationIds))
	for i, id := range cr.AnnotationIds {
		ids[i] = uuidToString(id)
	}
	var mergeCommit *string
	if cr.MergeCommit.Valid {
		mergeCommit = &cr.MergeCommit.String
	}
	var mergedAt *string
	if cr.MergedAt.Valid {
		s := timestampToString(cr.MergedAt)
		mergedAt = &s
	}

	return KnowledgeChangeRequestResponse{
		ID: uuidToString(cr.ID), Number: int(cr.Number), Title: cr.Title, Source: cr.Source,
		AuthorType: cr.AuthorType, AuthorID: uuidToString(cr.AuthorID), AuthorName: authorName,
		Branch: cr.Branch, BaseCommit: cr.BaseCommit, HeadCommit: cr.HeadCommit, Status: cr.Status,
		Conflict: cr.Conflict, ConflictFiles: nonNilStrings(cr.ConflictFiles), Summary: cr.Summary, Risk: cr.Risk,
		MergeCommit: mergeCommit, ChatSessionID: uuidToPtr(cr.ChatSessionID), AnnotationIDs: ids,
		KBSlugs: nonNilStrings(cr.KbSlugs), MergedAt: mergedAt,
		CreatedAt: timestampToString(cr.CreatedAt), UpdatedAt: timestampToString(cr.UpdatedAt),
	}
}

// actorNames 一次查出变更请求作者（成员或智能体）的名称；查不到时名称为空，不影响主流程。
func (h *Handler) actorNames(ctx context.Context, crs []db.KnowledgeChangeRequest) map[string]string {
	users, agents := []pgtype.UUID{}, []pgtype.UUID{}
	for _, cr := range crs {
		if cr.AuthorType == actorTypeAgent {
			agents = append(agents, cr.AuthorID)
		} else {
			users = append(users, cr.AuthorID)
		}
	}

	return h.lookupActorNames(ctx, users, agents)
}

func (h *Handler) lookupActorNames(ctx context.Context, users, agents []pgtype.UUID) map[string]string {
	names := map[string]string{}
	if len(users) == 0 && len(agents) == 0 {
		return names
	}
	rows, err := h.Queries.ListKnowledgeActorNames(ctx, db.ListKnowledgeActorNamesParams{UserIds: users, AgentIds: agents})
	if err != nil {
		return names
	}
	for _, row := range rows {
		names[uuidToString(row.ID)] = row.Name
	}

	return names
}

// changeSnapshot 是从分支算出的变更请求状态：基线、diff 涉及的知识库、冲突。
type changeSnapshot struct {
	Head      string
	Base      string
	Files     []knowledge.FileDiff
	Slugs     []string
	Conflicts []string
}

// snapshotBranch 读取分支，计算相对主线的 diff 与合并冲突。
func (h *Handler) snapshotBranch(ctx context.Context, workspaceID, branch string) (changeSnapshot, error) {
	head, err := h.Knowledge.Resolve(ctx, workspaceID, knowledge.BranchRef(branch))
	if err != nil {
		return changeSnapshot{}, err
	}
	mainHead, err := h.Knowledge.Head(ctx, workspaceID)
	if err != nil {
		return changeSnapshot{}, err
	}
	base, err := h.Knowledge.MergeBase(ctx, workspaceID, mainHead, head)
	if err != nil {
		return changeSnapshot{}, err
	}
	files, err := h.Knowledge.Diff(ctx, workspaceID, base, head)
	if err != nil {
		return changeSnapshot{}, err
	}
	merge, err := h.Knowledge.TryMerge(ctx, workspaceID, mainHead, head)
	if err != nil {
		return changeSnapshot{}, err
	}

	slugSet := map[string]bool{}
	for _, f := range files {
		if s := knowledge.SlugOf(f.Path); s != "" {
			slugSet[s] = true
		}
	}
	slugs := make([]string, 0, len(slugSet))
	for s := range slugSet {
		slugs = append(slugs, s)
	}
	sort.Strings(slugs)

	return changeSnapshot{Head: head, Base: base, Files: files, Slugs: slugs, Conflicts: merge.Conflicts}, nil
}

// currentConflicts 返回分支头与当前主线试合并的冲突文件。
func (h *Handler) currentConflicts(ctx context.Context, workspaceID, head string) ([]string, error) {
	mainHead, err := h.Knowledge.Head(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	merge, err := h.Knowledge.TryMerge(ctx, workspaceID, mainHead, head)
	if err != nil {
		return nil, err
	}

	return nonNilStrings(merge.Conflicts), nil
}

// CreateKnowledgeChangeRequestRequest 是创建变更请求的请求体：分支需先推送到仓库。
type CreateKnowledgeChangeRequestRequest struct {
	Branch        string   `json:"branch"`
	Title         string   `json:"title"`
	Source        string   `json:"source"`
	Summary       string   `json:"summary"`
	Risk          string   `json:"risk"`
	AnnotationIDs []string `json:"annotation_ids"`
	ChatSessionID string   `json:"chat_session_id"`
}

// CreateKnowledgeChangeRequest 为一个 kb/* 分支打开变更请求（POST /api/knowledge/changes）。
func (h *Handler) CreateKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
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
	var req CreateKnowledgeChangeRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	in, ok := validateChangeInput(w, req)
	if !ok {
		return
	}
	if in.Source == "" {
		in.Source = changeSourceEdit
		if actorType == actorTypeAgent {
			in.Source = changeSourceAgent
		}
	}

	cr, snap, err := h.openChangeRequest(r.Context(), workspaceID, in, actorType, actorID)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}

	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	h.writeChangeDetail(w, r, http.StatusCreated, cr, snap.Files)
}

type changeInput struct {
	Branch        string
	Title         string
	Source        string
	Summary       string
	Risk          string
	AnnotationIDs []pgtype.UUID
	ChatSessionID pgtype.UUID
}

var errNoChanges = errors.New("branch has no changes against main")

func validateChangeInput(w http.ResponseWriter, req CreateKnowledgeChangeRequestRequest) (changeInput, bool) {
	in := changeInput{Branch: strings.TrimSpace(req.Branch), Title: strings.TrimSpace(req.Title), Source: req.Source, Summary: strings.TrimSpace(req.Summary), Risk: req.Risk}
	if !strings.HasPrefix(in.Branch, knowledge.BranchPrefix) || strings.ContainsAny(in.Branch, " \t\n~^:?*[\\") {
		writeError(w, http.StatusBadRequest, "branch must start with kb/")
		return in, false
	}
	if in.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return in, false
	}
	if in.Source != "" && !validChangeSources[in.Source] {
		writeError(w, http.StatusBadRequest, "invalid source")
		return in, false
	}
	if in.Risk == "" {
		in.Risk = changeRiskLow
	} else if !validChangeRisks[in.Risk] {
		writeError(w, http.StatusBadRequest, "risk must be low, medium or high")
		return in, false
	}
	for _, id := range req.AnnotationIDs {
		u, ok := parseUUIDOrBadRequest(w, id, "annotation_ids")
		if !ok {
			return in, false
		}
		in.AnnotationIDs = append(in.AnnotationIDs, u)
	}
	if req.ChatSessionID != "" {
		u, ok := parseUUIDOrBadRequest(w, req.ChatSessionID, "chat_session_id")
		if !ok {
			return in, false
		}
		in.ChatSessionID = u
	}
	return in, true
}

// openChangeRequest 计算分支快照、分配编号并写入变更请求，关联批注转为处理中。
func (h *Handler) openChangeRequest(ctx context.Context, workspaceID string, in changeInput, actorType, actorID string) (db.KnowledgeChangeRequest, changeSnapshot, error) {
	snap, err := h.snapshotBranch(ctx, workspaceID, in.Branch)
	if err != nil {
		return db.KnowledgeChangeRequest{}, snap, err
	}
	if len(snap.Files) == 0 {
		return db.KnowledgeChangeRequest{}, snap, errNoChanges
	}
	wsUUID := parseUUID(workspaceID)
	if existing, err := h.Queries.GetOpenKnowledgeChangeRequestByBranch(ctx, db.GetOpenKnowledgeChangeRequestByBranchParams{WorkspaceID: wsUUID, Branch: in.Branch}); err == nil {
		return existing, snap, errBranchHasChange
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.KnowledgeChangeRequest{}, snap, errors.Wrapf(err, "find change request branch=%s", in.Branch)
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.KnowledgeChangeRequest{}, snap, errors.WithStack(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)
	number, err := qtx.AllocateKnowledgeChangeNumber(ctx, wsUUID)
	if err != nil {
		return db.KnowledgeChangeRequest{}, snap, errors.Wrapf(err, "allocate change number workspace_id=%s", workspaceID)
	}
	annotationIDs := in.AnnotationIDs
	if annotationIDs == nil {
		annotationIDs = []pgtype.UUID{}
	}
	cr, err := qtx.CreateKnowledgeChangeRequest(ctx, db.CreateKnowledgeChangeRequestParams{
		WorkspaceID: wsUUID, Number: number, Title: in.Title, Source: in.Source, AuthorType: actorType, AuthorID: parseUUID(actorID),
		Branch: in.Branch, BaseCommit: snap.Base, HeadCommit: snap.Head, Conflict: len(snap.Conflicts) > 0,
		ConflictFiles: nonNilStrings(snap.Conflicts), Summary: in.Summary, Risk: in.Risk, ChatSessionID: in.ChatSessionID,
		AnnotationIds: annotationIDs, KbSlugs: snap.Slugs,
	})
	if err != nil {
		return db.KnowledgeChangeRequest{}, snap, errors.Wrapf(err, "create change request branch=%s", in.Branch)
	}
	if len(annotationIDs) > 0 {
		if err := qtx.SetKnowledgeAnnotationsStatusForChange(ctx, db.SetKnowledgeAnnotationsStatusForChangeParams{
			Status: annotationProcessing, ChangeRequestID: cr.ID, WorkspaceID: wsUUID, Ids: annotationIDs,
		}); err != nil {
			return db.KnowledgeChangeRequest{}, snap, errors.Wrapf(err, "link annotations change=%d", number)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return db.KnowledgeChangeRequest{}, snap, errors.WithStack(err)
	}

	return cr, snap, nil
}

var errBranchHasChange = errors.New("branch already has an open change request")

func writeChangeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, knowledge.ErrNotFound):
		writeError(w, http.StatusBadRequest, "branch not found; push it first")
	case errors.Is(err, errNoChanges):
		writeError(w, http.StatusBadRequest, errNoChanges.Error())
	case errors.Is(err, errBranchHasChange):
		writeError(w, http.StatusConflict, "branch already has an open change request; update it instead")
	default:
		writeKnowledgeError(w, r, err, "failed to save change request")
	}
}

// loadChangeRequest 按 URL 参数 number 加载变更请求。
func (h *Handler) loadChangeRequest(w http.ResponseWriter, r *http.Request, workspaceID string) (db.KnowledgeChangeRequest, bool) {
	n, err := strconv.Atoi(strings.TrimPrefix(chi.URLParam(r, "number"), "#"))
	if err != nil || n <= 0 {
		writeError(w, http.StatusBadRequest, "invalid change request number")
		return db.KnowledgeChangeRequest{}, false
	}
	cr, err := h.Queries.GetKnowledgeChangeRequest(r.Context(), db.GetKnowledgeChangeRequestParams{WorkspaceID: parseUUID(workspaceID), Number: int32(n)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "change request not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load change request")
		}
		return db.KnowledgeChangeRequest{}, false
	}

	return cr, true
}

// UpdateKnowledgeChangeRequestRequest 是更新变更请求的请求体；分支重新推送后调用，省略的字段保持不变。
type UpdateKnowledgeChangeRequestRequest struct {
	Title         *string   `json:"title"`
	Summary       *string   `json:"summary"`
	Risk          *string   `json:"risk"`
	AnnotationIDs *[]string `json:"annotation_ids"`
}

// UpdateKnowledgeChangeRequest 按分支最新提交刷新变更请求（PATCH /api/knowledge/changes/{number}）。
func (h *Handler) UpdateKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
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
	if cr.Status != changeStatusOpen {
		writeError(w, http.StatusConflict, "change request is not open")
		return
	}
	var req UpdateKnowledgeChangeRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	title, summary, risk, annotationIDs := cr.Title, cr.Summary, cr.Risk, cr.AnnotationIds
	if req.Title != nil && strings.TrimSpace(*req.Title) != "" {
		title = strings.TrimSpace(*req.Title)
	}
	if req.Summary != nil {
		summary = strings.TrimSpace(*req.Summary)
	}
	if req.Risk != nil {
		if !validChangeRisks[*req.Risk] {
			writeError(w, http.StatusBadRequest, "risk must be low, medium or high")
			return
		}
		risk = *req.Risk
	}
	if req.AnnotationIDs != nil {
		annotationIDs = []pgtype.UUID{}
		for _, id := range *req.AnnotationIDs {
			u, ok := parseUUIDOrBadRequest(w, id, "annotation_ids")
			if !ok {
				return
			}
			annotationIDs = append(annotationIDs, u)
		}
	}

	snap, err := h.snapshotBranch(r.Context(), workspaceID, cr.Branch)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	updated, err := h.Queries.RefreshKnowledgeChangeRequest(r.Context(), db.RefreshKnowledgeChangeRequestParams{
		Title: title, Summary: summary, Risk: risk, BaseCommit: snap.Base, HeadCommit: snap.Head,
		Conflict: len(snap.Conflicts) > 0, ConflictFiles: nonNilStrings(snap.Conflicts), KbSlugs: snap.Slugs,
		AnnotationIds: annotationIDs, ID: cr.ID, WorkspaceID: cr.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update change request")
		return
	}
	if len(annotationIDs) > 0 {
		if err := h.Queries.SetKnowledgeAnnotationsStatusForChange(r.Context(), db.SetKnowledgeAnnotationsStatusForChangeParams{
			Status: annotationProcessing, ChangeRequestID: cr.ID, WorkspaceID: cr.WorkspaceID, Ids: annotationIDs,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to link annotations")
			return
		}
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventChangeRequest, uuidToString(cr.ID))
	h.writeChangeDetail(w, r, http.StatusOK, updated, snap.Files)
}

// ListKnowledgeChangeRequests 列出变更请求（GET /api/knowledge/changes?status=）。
func (h *Handler) ListKnowledgeChangeRequests(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	status := pgtype.Text{}
	if s := r.URL.Query().Get("status"); s != "" {
		if s != changeStatusOpen && s != changeStatusMerged && s != changeStatusClosed {
			writeError(w, http.StatusBadRequest, "invalid status")
			return
		}
		status = pgtype.Text{String: s, Valid: true}
	}

	crs, err := h.Queries.ListKnowledgeChangeRequests(r.Context(), db.ListKnowledgeChangeRequestsParams{WorkspaceID: parseUUID(workspaceID), Status: status})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list change requests")
		return
	}
	names := h.actorNames(r.Context(), crs)
	resp := make([]KnowledgeChangeRequestResponse, len(crs))
	for i, cr := range crs {
		resp[i] = changeRequestToResponse(cr, names[uuidToString(cr.AuthorID)])
	}

	writeJSON(w, http.StatusOK, resp)
}

// KnowledgeChangeComment 是变更请求上的行评论。
type KnowledgeChangeComment struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Line       int    `json:"line"`
	AuthorType string `json:"author_type"`
	AuthorID   string `json:"author_id"`
	Body       string `json:"body"`
	CreatedAt  string `json:"created_at"`
}

// KnowledgeChangeFileGroup 是 diff 按知识库分组的结果。
type KnowledgeChangeFileGroup struct {
	Slug  string               `json:"slug"`
	Files []knowledge.FileDiff `json:"files"`
}

// KnowledgeChangeDetailResponse 是变更请求详情：分组 diff 与行评论。
type KnowledgeChangeDetailResponse struct {
	KnowledgeChangeRequestResponse
	Groups   []KnowledgeChangeFileGroup `json:"groups"`
	Comments []KnowledgeChangeComment   `json:"comments"`
	Checks   KnowledgeChangeChecks      `json:"checks"`
}

// KnowledgeChangeChecks 是审核时展示的自动检查：变更涉及文件的 lint 问题与已过 stale_after 的页面。
// 能否合并由 conflict 字段表示；服务端拿不到代码仓库，按证据版本的比对只在 CLI 的 kb stale 里做。
type KnowledgeChangeChecks struct {
	Lint  []knowledge.LintIssue `json:"lint"`
	Stale []knowledge.StaleItem `json:"stale"`
}

// changeChecks 在变更请求的 head 提交上运行检查，只保留变更涉及的文件。
func (h *Handler) changeChecks(ctx context.Context, workspaceID string, cr db.KnowledgeChangeRequest, files []knowledge.FileDiff) (KnowledgeChangeChecks, error) {
	checks := KnowledgeChangeChecks{Lint: []knowledge.LintIssue{}, Stale: []knowledge.StaleItem{}}
	corpus, err := h.Knowledge.LoadCorpus(ctx, workspaceID, cr.HeadCommit)
	if err != nil {
		return checks, err
	}

	touched := map[string]bool{}
	slugs := map[string]bool{}
	for _, f := range files {
		touched[f.Path] = true
		slugs[knowledge.SlugOf(f.Path)] = true
	}

	for s := range slugs {
		for _, is := range corpus.Lint(s) {
			if touched[is.Path] {
				checks.Lint = append(checks.Lint, is)
			}
		}
		items, err := corpus.Stale(s, time.Now(), nil)
		if err != nil {
			return checks, err
		}
		for _, it := range items {
			if it.Reason == knowledge.StaleExpired && touched[it.Path] {
				checks.Stale = append(checks.Stale, it)
			}
		}
	}
	sort.Slice(checks.Lint, func(i, j int) bool { return checks.Lint[i].Path < checks.Lint[j].Path })
	sort.Slice(checks.Stale, func(i, j int) bool { return checks.Stale[i].Path < checks.Stale[j].Path })

	return checks, nil
}

func (h *Handler) changeDetail(ctx context.Context, cr db.KnowledgeChangeRequest, files []knowledge.FileDiff) (KnowledgeChangeDetailResponse, error) {
	names := h.actorNames(ctx, []db.KnowledgeChangeRequest{cr})
	bySlug := map[string][]knowledge.FileDiff{}
	var order []string
	for _, f := range files {
		s := knowledge.SlugOf(f.Path)
		if _, ok := bySlug[s]; !ok {
			order = append(order, s)
		}
		bySlug[s] = append(bySlug[s], f)
	}
	sort.Strings(order)
	groups := make([]KnowledgeChangeFileGroup, 0, len(order))
	for _, s := range order {
		groups = append(groups, KnowledgeChangeFileGroup{Slug: s, Files: bySlug[s]})
	}

	comments := []KnowledgeChangeComment{}
	rows, err := h.Queries.ListKnowledgeChangeComments(ctx, cr.ID)
	if err != nil {
		return KnowledgeChangeDetailResponse{}, errors.Wrapf(err, "list change comments change_request_id=%s", uuidToString(cr.ID))
	}
	for _, c := range rows {
		comments = append(comments, KnowledgeChangeComment{
			ID: uuidToString(c.ID), Path: c.Path, Line: int(c.Line), AuthorType: c.AuthorType, AuthorID: uuidToString(c.AuthorID),
			Body: c.Body, CreatedAt: timestampToString(c.CreatedAt),
		})
	}

	return KnowledgeChangeDetailResponse{
		KnowledgeChangeRequestResponse: changeRequestToResponse(cr, names[uuidToString(cr.AuthorID)]),
		Groups:                         groups,
		Comments:                       comments,
		Checks:                         KnowledgeChangeChecks{Lint: []knowledge.LintIssue{}, Stale: []knowledge.StaleItem{}},
	}, nil
}

// writeChangeDetail 写出变更请求详情；读取评论失败时返回 500。
func (h *Handler) writeChangeDetail(w http.ResponseWriter, r *http.Request, status int, cr db.KnowledgeChangeRequest, files []knowledge.FileDiff) {
	detail, err := h.changeDetail(r.Context(), cr, files)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load change request")
		return
	}

	writeJSON(w, status, detail)
}

// GetKnowledgeChangeRequest 返回变更请求详情（GET /api/knowledge/changes/{number}）。
func (h *Handler) GetKnowledgeChangeRequest(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	cr, ok := h.loadChangeRequest(w, r, workspaceID)
	if !ok {
		return
	}

	// 已合并的变更请求按合并时的基线与分支头展示；分支删除后仍可从 head 提交读到。
	files, err := h.Knowledge.Diff(r.Context(), workspaceID, cr.BaseCommit, cr.HeadCommit)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to compute diff")
		return
	}

	checks, err := h.changeChecks(r.Context(), workspaceID, cr, files)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to run checks")
		return
	}

	// 主线在变更请求创建后可能又前进了：打开的变更请求每次查看都和当前主线重新试合并，
	// 「能否合并」才不会停留在上次更新时的结论。
	if cr.Status == changeStatusOpen {
		conflicts, err := h.currentConflicts(r.Context(), workspaceID, cr.HeadCommit)
		if err != nil {
			writeKnowledgeError(w, r, err, "failed to check mergeability")
			return
		}
		cr.Conflict, cr.ConflictFiles = len(conflicts) > 0, conflicts
	}

	detail, err := h.changeDetail(r.Context(), cr, files)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load change request")
		return
	}
	detail.Checks = checks

	writeJSON(w, http.StatusOK, detail)
}
