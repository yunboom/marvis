package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/knowledge"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// 内置知识库的 slug 与名称：工作区第一次打开知识库时生成。
const (
	builtinKnowledgeSlug = "team"
	builtinKnowledgeName = "团队知识库"
)

// knowledgeEventKind 是 knowledge:changed 事件里标明变化对象的取值。
const (
	knowledgeEventBase          = "base"
	knowledgeEventChangeRequest = "change_request"
	knowledgeEventAnnotation    = "annotation"
	knowledgeEventGap           = "gap"
)

const knowledgeCommitRetries = 3

var knowledgeSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// KnowledgeBaseResponse 是知识库的接口表示。
type KnowledgeBaseResponse struct {
	ID                string  `json:"id"`
	WorkspaceID       string  `json:"workspace_id"`
	Name              string  `json:"name"`
	Slug              string  `json:"slug"`
	Description       string  `json:"description"`
	MaintainerAgentID *string `json:"maintainer_agent_id"`
	CreatedBy         string  `json:"created_by"`
	PageCount         int     `json:"page_count"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
}

func knowledgeBaseToResponse(kb db.KnowledgeBase, pageCount int) KnowledgeBaseResponse {
	return KnowledgeBaseResponse{
		ID:                uuidToString(kb.ID),
		WorkspaceID:       uuidToString(kb.WorkspaceID),
		Name:              kb.Name,
		Slug:              kb.Slug,
		Description:       kb.Description,
		MaintainerAgentID: uuidToPtr(kb.MaintainerAgentID),
		CreatedBy:         uuidToString(kb.CreatedBy),
		PageCount:         pageCount,
		CreatedAt:         timestampToString(kb.CreatedAt),
		UpdatedAt:         timestampToString(kb.UpdatedAt),
	}
}

func (h *Handler) requireKnowledgeStore(w http.ResponseWriter) bool {
	if h.Knowledge == nil {
		writeFeatureDisabled(w, "knowledge_unavailable", "knowledge base requires git on the server")

		return false
	}

	return true
}

func (h *Handler) removeKnowledgeRepo(workspaceID string) {
	if h.Knowledge == nil || !workspaceIDLike(workspaceID) {
		return
	}
	if err := os.RemoveAll(h.Knowledge.RepoDir(workspaceID)); err != nil {
		slog.Error("failed to remove knowledge repository", "workspace_id", workspaceID, "error", err)
	}
}

func workspaceIDLike(id string) bool { return len(id) == 36 && strings.Count(id, "-") == 4 }

// ensureKnowledgeRepo 保证工作区仓库存在；第一次注册时生成内置的团队知识库。
func (h *Handler) ensureKnowledgeRepo(ctx context.Context, workspaceID, userID string) error {
	if err := h.Knowledge.Ensure(ctx, workspaceID); err != nil {
		return err
	}
	wsUUID := parseUUID(workspaceID)
	if _, err := h.Queries.GetKnowledgeRepo(ctx, wsUUID); err == nil {
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return errors.Wrapf(err, "load knowledge repo workspace_id=%s", workspaceID)
	}

	if _, err := h.Queries.CreateKnowledgeRepo(ctx, wsUUID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // 并发请求已经注册并负责生成内置知识库
		}

		return errors.Wrapf(err, "register knowledge repo workspace_id=%s", workspaceID)
	}

	purpose := h.builtinKnowledgePurpose(ctx, wsUUID, userID)
	_, err := h.createKnowledgeBase(ctx, workspaceID, userID, builtinKnowledgeName, builtinKnowledgeSlug, purpose, purpose, pgtype.UUID{})

	return err
}

// builtinKnowledgePurpose 用工作区名称和创建者「关于你」的答案拼出内置库的 purpose。
func (h *Handler) builtinKnowledgePurpose(ctx context.Context, wsUUID pgtype.UUID, userID string) string {
	var b strings.Builder
	if ws, err := h.Queries.GetWorkspace(ctx, wsUUID); err == nil {
		b.WriteString(ws.Name + " 团队知识库。")
		if d := strings.TrimSpace(ws.Description.String); d != "" {
			b.WriteString(d)
		}
	}
	if user, err := h.Queries.GetUser(ctx, parseUUID(userID)); err == nil && len(user.OnboardingQuestionnaire) > 0 {
		var q struct {
			Role    string   `json:"role"`
			UseCase []string `json:"use_case"`
		}
		if json.Unmarshal(user.OnboardingQuestionnaire, &q) == nil {
			if label := onboardingRoleLabels[q.Role]; label != "" {
				b.WriteString("\n\n创建者角色：" + label + "。")
			}
			var uses []string
			for _, u := range q.UseCase {
				if label := onboardingUseCaseLabels[u]; label != "" {
					uses = append(uses, label)
				}
			}
			if len(uses) > 0 {
				b.WriteString("主要用途：" + strings.Join(uses, "、") + "。")
			}
		}
	}
	b.WriteString("\n\n收录：系统与模块、业务规则、开发 / 测试 / 发布流程、决策记录，以及任务和对话里沉淀下来的结论。")

	return b.String()
}

// onboardingRoleLabels / onboardingUseCaseLabels 对应开局问卷的选项，写入 purpose.md。
var onboardingRoleLabels = map[string]string{
	"engineer": "工程师 / 开发者", "product": "产品经理", "designer": "设计师", "founder": "创始人",
	"marketing": "市场", "writer": "写作者", "research": "研究", "ops": "运营", "student": "学生",
}

var onboardingUseCaseLabels = map[string]string{
	"ship_code": "让 AI 智能体写代码", "manage_team": "团队任务管理", "personal_tasks": "个人任务",
	"plan_research": "规划与调研", "write_publish": "写作与发布", "automate_ops": "自动化运营", "evaluate": "评估试用",
}

func (h *Handler) memberSignature(ctx context.Context, userID string) knowledge.Signature {
	user, err := h.Queries.GetUser(ctx, parseUUID(userID))
	if err != nil {
		return knowledge.Signature{}
	}

	return knowledge.Signature{Name: user.Name, Email: user.Email}
}

// commitKnowledgeMain 在主线上提交 build 返回的改动；主线被并发移动时重读后重试。
func (h *Handler) commitKnowledgeMain(ctx context.Context, workspaceID, message string, sig knowledge.Signature, build func(head string) ([]knowledge.FileChange, error)) (string, error) {
	for attempt := 0; ; attempt++ {
		head, err := h.Knowledge.Head(ctx, workspaceID)
		if err != nil {
			return "", err
		}
		changes, err := build(head)
		if err != nil {
			return "", err
		}
		commit, err := h.Knowledge.Commit(ctx, workspaceID, knowledge.MainRef, head, head, message, sig, changes)
		if errors.Is(err, knowledge.ErrRefMoved) && attempt < knowledgeCommitRetries {
			continue
		}

		return commit, err
	}
}

// readmeChange 生成仓库根 README，列出当前所有知识库（含即将创建或去掉的那一个）。
func readmeChange(bases []db.KnowledgeBase, extra *db.KnowledgeBase, removedSlug string) knowledge.FileChange {
	entries := make([]knowledge.KnowledgeBaseEntry, 0, len(bases)+1)
	for _, b := range bases {
		if b.Slug == removedSlug || (extra != nil && b.Slug == extra.Slug) {
			continue
		}
		entries = append(entries, knowledge.KnowledgeBaseEntry{Name: b.Name, Slug: b.Slug, Description: b.Description})
	}
	if extra != nil {
		entries = append(entries, knowledge.KnowledgeBaseEntry{Name: extra.Name, Slug: extra.Slug, Description: extra.Description})
	}

	return knowledge.ReadmeFile(entries)
}

func (h *Handler) createKnowledgeBase(ctx context.Context, workspaceID, userID, name, slug, description, purpose string, maintainer pgtype.UUID) (db.KnowledgeBase, error) {
	wsUUID := parseUUID(workspaceID)
	kb, err := h.Queries.CreateKnowledgeBase(ctx, db.CreateKnowledgeBaseParams{
		WorkspaceID:       wsUUID,
		Name:              name,
		Slug:              slug,
		Description:       description,
		MaintainerAgentID: maintainer,
		CreatedBy:         parseUUID(userID),
	})
	if err != nil {
		return db.KnowledgeBase{}, errors.Wrapf(err, "create knowledge base workspace_id=%s slug=%s", workspaceID, slug)
	}

	bases, err := h.Queries.ListKnowledgeBases(ctx, wsUUID)
	if err != nil {
		return db.KnowledgeBase{}, errors.Wrapf(err, "list knowledge bases workspace_id=%s", workspaceID)
	}
	files, err := knowledge.BuiltinFiles(knowledge.SchemaInput{Name: name, Slug: slug, Purpose: purpose})
	if err != nil {
		return db.KnowledgeBase{}, err
	}
	_, err = h.commitKnowledgeMain(ctx, workspaceID, "Create knowledge base "+slug, h.memberSignature(ctx, userID), func(string) ([]knowledge.FileChange, error) {
		return append(files, readmeChange(bases, &kb, "")), nil
	})
	if err != nil {
		// 仓库写失败时撤回数据库行，避免出现没有目录的知识库。
		if delErr := h.Queries.DeleteKnowledgeBase(ctx, db.DeleteKnowledgeBaseParams{ID: kb.ID, WorkspaceID: wsUUID}); delErr != nil {
			slog.Error("failed to roll back knowledge base row", "knowledge_base_id", uuidToString(kb.ID), "error", delErr)
		}

		return db.KnowledgeBase{}, err
	}

	return kb, nil
}

// knowledgePageCounts 一次列出主线文件，统计每个知识库 wiki/ 下的页面数。
func (h *Handler) knowledgePageCounts(ctx context.Context, workspaceID string) (map[string]int, error) {
	head, err := h.Knowledge.Head(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	files, err := h.Knowledge.ListFiles(ctx, workspaceID, head, "")
	if err != nil {
		return nil, err
	}

	counts := map[string]int{}
	for _, f := range files {
		parts := strings.SplitN(f, "/", 3)
		if len(parts) == 3 && parts[1] == "wiki" && strings.HasSuffix(f, ".md") {
			counts[parts[0]]++
		}
	}

	return counts, nil
}

// ListKnowledgeBases 列出工作区的知识库（GET /api/knowledge/bases）。
func (h *Handler) ListKnowledgeBases(w http.ResponseWriter, r *http.Request) {
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

	if err := h.ensureKnowledgeRepo(r.Context(), workspaceID, userID); err != nil {
		writeKnowledgeError(w, r, err, "failed to prepare knowledge repository")
		return
	}
	bases, err := h.Queries.ListKnowledgeBases(r.Context(), parseUUID(workspaceID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge bases")
		return
	}
	counts, err := h.knowledgePageCounts(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	resp := make([]KnowledgeBaseResponse, len(bases))
	for i, b := range bases {
		resp[i] = knowledgeBaseToResponse(b, counts[b.Slug])
	}

	writeJSON(w, http.StatusOK, resp)
}

// loadKnowledgeBase 按 URL 参数 id（UUID 或 slug）加载当前工作区的知识库。
func (h *Handler) loadKnowledgeBase(w http.ResponseWriter, r *http.Request, workspaceID string) (db.KnowledgeBase, bool) {
	ref := chi.URLParam(r, "id")
	wsUUID := parseUUID(workspaceID)
	var kb db.KnowledgeBase
	var err error
	if id, perr := parseUUIDLoose(ref); perr == nil {
		kb, err = h.Queries.GetKnowledgeBase(r.Context(), db.GetKnowledgeBaseParams{ID: id, WorkspaceID: wsUUID})
	} else {
		kb, err = h.Queries.GetKnowledgeBaseBySlug(r.Context(), db.GetKnowledgeBaseBySlugParams{WorkspaceID: wsUUID, Slug: ref})
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "knowledge base not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load knowledge base")
		}

		return db.KnowledgeBase{}, false
	}

	return kb, true
}

// GetKnowledgeBase 返回单个知识库（GET /api/knowledge/bases/{id}）。
func (h *Handler) GetKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	kb, ok := h.loadKnowledgeBase(w, r, workspaceID)
	if !ok {
		return
	}
	counts, err := h.knowledgePageCounts(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	writeJSON(w, http.StatusOK, knowledgeBaseToResponse(kb, counts[kb.Slug]))
}

// CreateKnowledgeBaseRequest 是新建知识库的请求体。
type CreateKnowledgeBaseRequest struct {
	Name              string  `json:"name"`
	Slug              string  `json:"slug"`
	Description       string  `json:"description"`
	Purpose           string  `json:"purpose"`
	MaintainerAgentID *string `json:"maintainer_agent_id"`
}

// CreateKnowledgeBase 用内置 schema 新建知识库（POST /api/knowledge/bases）。
func (h *Handler) CreateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
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

	var req CreateKnowledgeBaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	maintainer, ok := h.resolveMaintainerAgent(w, r, workspaceID, req.MaintainerAgentID)
	if !ok {
		return
	}

	if err := h.ensureKnowledgeRepo(r.Context(), workspaceID, userID); err != nil {
		writeKnowledgeError(w, r, err, "failed to prepare knowledge repository")
		return
	}
	bases, err := h.Queries.ListKnowledgeBases(r.Context(), parseUUID(workspaceID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge bases")
		return
	}
	slug := strings.TrimSpace(req.Slug)
	if slug == "" {
		slug = uniqueKnowledgeSlug(req.Name, bases)
	} else if !knowledgeSlugPattern.MatchString(slug) {
		writeError(w, http.StatusBadRequest, "slug must be lowercase letters, digits and hyphens")
		return
	}
	for _, b := range bases {
		if b.Slug == slug {
			writeError(w, http.StatusConflict, "a knowledge base with this slug already exists")
			return
		}
	}
	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = strings.TrimSpace(req.Description)
	}

	kb, err := h.createKnowledgeBase(r.Context(), workspaceID, userID, req.Name, slug, strings.TrimSpace(req.Description), purpose, maintainer)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to create knowledge base")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventBase, uuidToString(kb.ID))
	writeJSON(w, http.StatusCreated, knowledgeBaseToResponse(kb, 0))
}

// uniqueKnowledgeSlug 由名称生成目录名；中文等非 ASCII 名称退化为 kb-N。
func uniqueKnowledgeSlug(name string, bases []db.KnowledgeBase) string {
	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteRune('-')
			lastHyphen = true
		}
	}
	base := strings.Trim(b.String(), "-")
	if len(base) > 32 {
		base = strings.Trim(base[:32], "-")
	}
	if base == "" {
		base = "kb"
	}

	taken := map[string]bool{}
	for _, k := range bases {
		taken[k.Slug] = true
	}
	if !taken[base] && base != "kb" {
		return base
	}
	for i := 2; ; i++ {
		candidate := base + "-" + strconv.Itoa(i)
		if !taken[candidate] {
			return candidate
		}
	}
}

// resolveMaintainerAgent 校验维护智能体属于当前工作区；未传时返回空。
func (h *Handler) resolveMaintainerAgent(w http.ResponseWriter, r *http.Request, workspaceID string, agentID *string) (pgtype.UUID, bool) {
	if agentID == nil || strings.TrimSpace(*agentID) == "" {
		return pgtype.UUID{}, true
	}
	id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*agentID), "maintainer_agent_id")
	if !ok {
		return pgtype.UUID{}, false
	}
	agent, err := h.Queries.GetAgent(r.Context(), id)
	if err != nil || uuidToString(agent.WorkspaceID) != workspaceID {
		writeError(w, http.StatusBadRequest, "maintainer agent not found in this workspace")
		return pgtype.UUID{}, false
	}

	return agent.ID, true
}

// UpdateKnowledgeBaseRequest 是修改知识库的请求体；省略的字段保持不变。
type UpdateKnowledgeBaseRequest struct {
	Name              *string `json:"name"`
	Description       *string `json:"description"`
	MaintainerAgentID *string `json:"maintainer_agent_id"`
}

// UpdateKnowledgeBase 修改名称、描述、维护智能体（PATCH /api/knowledge/bases/{id}）。
func (h *Handler) UpdateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
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
	kb, ok := h.loadKnowledgeBase(w, r, workspaceID)
	if !ok {
		return
	}
	if !roleAllowed(member.Role, "owner", "admin") && uuidToString(kb.CreatedBy) != userID {
		writeError(w, http.StatusForbidden, "only the creator or a workspace owner or admin can change this knowledge base")
		return
	}

	var req UpdateKnowledgeBaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name, description, maintainer := kb.Name, kb.Description, kb.MaintainerAgentID
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
	}
	if req.Description != nil {
		description = strings.TrimSpace(*req.Description)
	}
	if req.MaintainerAgentID != nil {
		if maintainer, ok = h.resolveMaintainerAgent(w, r, workspaceID, req.MaintainerAgentID); !ok {
			return
		}
	}

	updated, err := h.Queries.UpdateKnowledgeBase(r.Context(), db.UpdateKnowledgeBaseParams{
		Name: name, Description: description, MaintainerAgentID: maintainer, ID: kb.ID, WorkspaceID: kb.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update knowledge base")
		return
	}
	if name != kb.Name || description != kb.Description {
		if err := h.rewriteKnowledgeReadme(r.Context(), workspaceID, userID); err != nil {
			writeKnowledgeError(w, r, err, "failed to update knowledge repository")
			return
		}
	}
	counts, err := h.knowledgePageCounts(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventBase, uuidToString(kb.ID))
	writeJSON(w, http.StatusOK, knowledgeBaseToResponse(updated, counts[updated.Slug]))
}

func (h *Handler) rewriteKnowledgeReadme(ctx context.Context, workspaceID, userID string) error {
	bases, err := h.Queries.ListKnowledgeBases(ctx, parseUUID(workspaceID))
	if err != nil {
		return errors.Wrapf(err, "list knowledge bases workspace_id=%s", workspaceID)
	}
	_, err = h.commitKnowledgeMain(ctx, workspaceID, "Update knowledge base list", h.memberSignature(ctx, userID), func(string) ([]knowledge.FileChange, error) {
		return []knowledge.FileChange{readmeChange(bases, nil, "")}, nil
	})

	return err
}

// KnowledgeDeleteImpactResponse 是删除知识库前展示的影响。
type KnowledgeDeleteImpactResponse struct {
	OpenAnnotations    int  `json:"open_annotations"`
	OpenChangeRequests int  `json:"open_change_requests"`
	LastKnowledgeBase  bool `json:"last_knowledge_base"`
}

// GetKnowledgeDeleteImpact 返回删除会一并关闭的内容（GET /api/knowledge/bases/{id}/delete-impact）。
func (h *Handler) GetKnowledgeDeleteImpact(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	kb, ok := h.loadKnowledgeBase(w, r, workspaceID)
	if !ok {
		return
	}

	impact, err := h.Queries.CountOpenKnowledgeWorkForBase(r.Context(), db.CountOpenKnowledgeWorkForBaseParams{
		KnowledgeBaseID: kb.ID, WorkspaceID: kb.WorkspaceID, Slug: kb.Slug,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count open knowledge work")
		return
	}
	total, err := h.Queries.CountKnowledgeBases(r.Context(), kb.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count knowledge bases")
		return
	}

	writeJSON(w, http.StatusOK, KnowledgeDeleteImpactResponse{
		OpenAnnotations: int(impact.OpenAnnotations), OpenChangeRequests: int(impact.OpenChangeRequests), LastKnowledgeBase: total <= 1,
	})
}

// DeleteKnowledgeBase 删除知识库：提交一次移除目录的 commit，关闭它的批注与变更请求（DELETE /api/knowledge/bases/{id}）。
func (h *Handler) DeleteKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "knowledge bases can only be deleted from the app")
		return
	}
	kb, ok := h.loadKnowledgeBase(w, r, workspaceID)
	if !ok {
		return
	}
	ctx := r.Context()

	bases, err := h.Queries.ListKnowledgeBases(ctx, kb.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge bases")
		return
	}
	_, err = h.commitKnowledgeMain(ctx, workspaceID, "Delete knowledge base "+kb.Slug, h.memberSignature(ctx, userID), func(head string) ([]knowledge.FileChange, error) {
		files, err := h.Knowledge.ListFiles(ctx, workspaceID, head, kb.Slug)
		if err != nil {
			return nil, err
		}
		changes := make([]knowledge.FileChange, 0, len(files)+1)
		for _, f := range files {
			changes = append(changes, knowledge.FileChange{Path: f, Delete: true})
		}

		return append(changes, readmeChange(bases, nil, kb.Slug)), nil
	})
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to remove knowledge base directory")
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete knowledge base")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DismissKnowledgeAnnotationsForBase(ctx, db.DismissKnowledgeAnnotationsForBaseParams{KnowledgeBaseID: kb.ID, WorkspaceID: kb.WorkspaceID}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close annotations")
		return
	}
	if err := qtx.CloseKnowledgeChangeRequestsForSlug(ctx, db.CloseKnowledgeChangeRequestsForSlugParams{WorkspaceID: kb.WorkspaceID, Slug: kb.Slug}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close change requests")
		return
	}
	if err := qtx.DeleteKnowledgeBase(ctx, db.DeleteKnowledgeBaseParams{ID: kb.ID, WorkspaceID: kb.WorkspaceID}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete knowledge base")
		return
	}
	if err := h.afterKnowledgeBaseRemoved(ctx, qtx, kb.WorkspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update knowledge digest")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete knowledge base")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventBase, uuidToString(kb.ID))
	w.WriteHeader(http.StatusNoContent)
}

// KnowledgeBaseBrief 是注入智能体 brief 的知识库条目。
type KnowledgeBaseBrief struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// knowledgeBriefs 列出工作区知识库供任务 brief 使用；读不到时返回空，不影响认领。
func (h *Handler) knowledgeBriefs(ctx context.Context, workspaceID pgtype.UUID) []KnowledgeBaseBrief {
	if h.Knowledge == nil {
		return nil
	}
	bases, err := h.Queries.ListKnowledgeBases(ctx, workspaceID)
	if err != nil {
		slog.Warn("task claim: failed to list knowledge bases", "workspace_id", uuidToString(workspaceID), "error", err)
		return nil
	}
	out := make([]KnowledgeBaseBrief, 0, len(bases))
	for _, b := range bases {
		out = append(out, KnowledgeBaseBrief{Slug: b.Slug, Name: b.Name, Description: b.Description})
	}

	return out
}

func (h *Handler) publishKnowledge(workspaceID, actorType, actorID, kind, id string) {
	h.publish(protocol.EventKnowledgeChanged, workspaceID, actorType, actorID, map[string]any{"kind": kind, "id": id})
}

// writeKnowledgeError 记录仓库层错误并返回 500；git 不可用等配置问题在日志里可查。
func writeKnowledgeError(w http.ResponseWriter, r *http.Request, err error, msg string) {
	slog.Error(msg, "path", r.URL.Path, "error", err)
	writeError(w, http.StatusInternalServerError, msg)
}
