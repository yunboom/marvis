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

// knowledgeGapStatus / knowledgeGapSource 是知识缺口的词表。
const (
	knowledgeGapOpen       = "open"
	knowledgeGapProcessing = "processing"
	knowledgeGapFilled     = "filled"

	knowledgeGapSearchMiss = "search_miss"
	knowledgeGapAgent      = "agent"
)

const knowledgeSearchDefaultLimit = 10

// KnowledgePageSummary 是页面树里的一项。
type KnowledgePageSummary struct {
	Path            string   `json:"path"`
	Group           string   `json:"group"`
	Title           string   `json:"title"`
	Type            string   `json:"type"`
	Domains         []string `json:"domains"`
	Verified        bool     `json:"verified"`
	NeedsCheck      bool     `json:"needs_check"`
	OpenAnnotations int      `json:"open_annotations"`
	AgentFindings   int      `json:"agent_findings"`
}

// KnowledgePageListResponse 是某个知识库的页面树。
type KnowledgePageListResponse struct {
	Commit string                 `json:"commit"`
	Groups []string               `json:"groups"`
	Pages  []KnowledgePageSummary `json:"pages"`
}

func (h *Handler) loadKnowledgeCorpus(ctx context.Context, workspaceID string) (*knowledge.Corpus, error) {
	head, err := h.Knowledge.Head(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	return h.Knowledge.LoadCorpus(ctx, workspaceID, head)
}

// requireKnowledgeBaseRead 校验成员身份并加载 URL 中的知识库，供只读接口共用。
func (h *Handler) requireKnowledgeBaseRead(w http.ResponseWriter, r *http.Request) (string, db.KnowledgeBase, bool) {
	if !h.requireKnowledgeStore(w) {
		return "", db.KnowledgeBase{}, false
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return "", db.KnowledgeBase{}, false
	}
	kb, ok := h.loadKnowledgeBase(w, r, workspaceID)

	return workspaceID, kb, ok
}

// ListKnowledgePages 返回知识库的页面树（GET /api/knowledge/bases/{id}/pages）。
func (h *Handler) ListKnowledgePages(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	corpus, err := h.loadKnowledgeCorpus(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}
	counts, err := h.Queries.CountKnowledgeAnnotationsByPage(r.Context(), kb.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count annotations")
		return
	}
	byPage := make(map[string]db.CountKnowledgeAnnotationsByPageRow, len(counts))
	for _, c := range counts {
		byPage[c.PagePath] = c
	}

	now := time.Now()
	pages := []KnowledgePageSummary{}
	for _, p := range corpus.PagesOf(kb.Slug) {
		c := byPage[p.Path]
		pages = append(pages, KnowledgePageSummary{
			Path: p.Path, Group: knowledge.GroupOf(p.Path), Title: p.Title, Type: p.FrontMatter.Type,
			Domains: nonNilStrings(p.FrontMatter.Domains), Verified: p.FrontMatter.Verified != nil,
			NeedsCheck: p.FrontMatter.IsStale(now), OpenAnnotations: int(c.OpenCount), AgentFindings: int(c.AgentCount),
		})
	}

	writeJSON(w, http.StatusOK, KnowledgePageListResponse{Commit: corpus.Commit, Groups: knowledge.PageGroups, Pages: pages})
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}

	return s
}

// KnowledgeSourceResponse 是页面脚注来源；对话来源只对会话主人暴露 URI。
type KnowledgeSourceResponse struct {
	N     int                  `json:"n"`
	Kind  string               `json:"kind"`
	URI   string               `json:"uri"`
	Label string               `json:"label"`
	Chat  *KnowledgeChatSource `json:"chat,omitempty"`
}

// KnowledgeChatSource 是对话来源的展示信息。
type KnowledgeChatSource struct {
	OwnerName string `json:"owner_name"`
	AgentName string `json:"agent_name"`
	CreatedAt string `json:"created_at"`
	Openable  bool   `json:"openable"`
	SessionID string `json:"session_id,omitempty"`
}

// KnowledgePageLink 是指向另一页面的链接。
type KnowledgePageLink struct {
	Path  string `json:"path"`
	Title string `json:"title"`
}

// KnowledgePageResponse 是页面详情。
type KnowledgePageResponse struct {
	Commit      string                    `json:"commit"`
	Path        string                    `json:"path"`
	Group       string                    `json:"group"`
	Title       string                    `json:"title"`
	FrontMatter knowledge.FrontMatter     `json:"front_matter"`
	NeedsCheck  bool                      `json:"needs_check"`
	Sections    []knowledge.Section       `json:"sections"`
	Sources     []KnowledgeSourceResponse `json:"sources"`
	Backlinks   []KnowledgePageLink       `json:"backlinks"`
	Markdown    string                    `json:"markdown"`
}

// GetKnowledgePage 返回页面详情（GET /api/knowledge/bases/{id}/page?path=）。
func (h *Handler) GetKnowledgePage(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	pagePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if !strings.HasPrefix(pagePath, kb.Slug+"/") {
		writeError(w, http.StatusBadRequest, "path must be inside the knowledge base")
		return
	}
	corpus, err := h.loadKnowledgeCorpus(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}
	page, found := corpus.Pages[pagePath]
	if !found {
		writeError(w, http.StatusNotFound, "page not found")
		return
	}
	raw, err := h.Knowledge.ReadFile(r.Context(), workspaceID, corpus.Commit, pagePath)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read page")
		return
	}

	sources, err := h.knowledgeSources(r.Context(), workspaceID, requestUserID(r), page.Footnotes)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve page sources")
		return
	}
	backlinks := []KnowledgePageLink{}
	for _, p := range corpus.Backlinks(pagePath) {
		if knowledge.SlugOf(p) == kb.Slug {
			backlinks = append(backlinks, KnowledgePageLink{Path: p, Title: corpus.Pages[p].Title})
		}
	}

	writeJSON(w, http.StatusOK, KnowledgePageResponse{
		Commit: corpus.Commit, Path: pagePath, Group: knowledge.GroupOf(pagePath), Title: page.Title,
		FrontMatter: page.FrontMatter, NeedsCheck: page.FrontMatter.IsStale(time.Now()),
		Sections: page.Sections, Sources: sources, Backlinks: backlinks, Markdown: string(raw),
	})
}

// knowledgeSources 把脚注转成接口来源；对话来源一次批量查出主人与智能体名称。
func (h *Handler) knowledgeSources(ctx context.Context, workspaceID, userID string, notes []knowledge.Footnote) ([]KnowledgeSourceResponse, error) {
	var ids []pgtype.UUID
	for _, n := range notes {
		if n.Kind == knowledge.SourceChat {
			if id, err := parseUUIDLoose(strings.TrimPrefix(n.URI, "chat://")); err == nil {
				ids = append(ids, id)
			}
		}
	}
	chats := map[string]db.ListKnowledgeChatSourcesRow{}
	if len(ids) > 0 {
		rows, err := h.Queries.ListKnowledgeChatSources(ctx, db.ListKnowledgeChatSourcesParams{WorkspaceID: parseUUID(workspaceID), Ids: ids})
		if err != nil {
			return nil, errors.Wrapf(err, "list chat sources workspace_id=%s", workspaceID)
		}
		for _, row := range rows {
			chats[uuidToString(row.ID)] = row
		}
	}

	out := make([]KnowledgeSourceResponse, 0, len(notes))
	for _, n := range notes {
		src := KnowledgeSourceResponse{N: n.N, Kind: n.Kind, URI: n.URI, Label: n.Label}
		if n.Kind == knowledge.SourceChat {
			// 对话只有本人能打开：其他人既拿不到会话 id，也看不到智能体写的标签。
			src.URI, src.Label = "", ""
			id := strings.TrimPrefix(n.URI, "chat://")
			if row, ok := chats[id]; ok {
				openable := uuidToString(row.CreatorID) == userID
				src.Chat = &KnowledgeChatSource{OwnerName: row.CreatorName, AgentName: row.AgentName, CreatedAt: timestampToString(row.CreatedAt), Openable: openable}
				if openable {
					src.Chat.SessionID = id
				}
			}
		}
		out = append(out, src)
	}

	return out, nil
}

// KnowledgeSearchResponse 是搜索结果；未命中且请求记录时带上新建或已有的缺口。
type KnowledgeSearchResponse struct {
	Hits []knowledge.SearchHit `json:"hits"`
	Gap  *KnowledgeGapResponse `json:"gap,omitempty"`
}

// SearchKnowledge 在所有知识库中搜索（GET /api/knowledge/search?q=&kb=&limit=&record_miss=）。
func (h *Handler) SearchKnowledge(w http.ResponseWriter, r *http.Request) {
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
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	limit := knowledgeSearchDefaultLimit
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 50 {
		limit = v
	}
	if err := h.ensureKnowledgeRepo(r.Context(), workspaceID, userID); err != nil {
		writeKnowledgeError(w, r, err, "failed to prepare knowledge repository")
		return
	}
	corpus, err := h.loadKnowledgeCorpus(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	resp := KnowledgeSearchResponse{Hits: corpus.Search(q, r.URL.Query().Get("kb"), limit)}
	if len(resp.Hits) == 0 && r.URL.Query().Get("record_miss") == "1" {
		actorType, actorID := h.resolveActor(r, userID, workspaceID)
		gap, err := h.recordKnowledgeGap(r.Context(), workspaceID, q, knowledgeGapSearchMiss, actorType, actorID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record knowledge gap")
			return
		}
		resp.Gap = &gap
		h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventGap, gap.ID)
	}

	writeJSON(w, http.StatusOK, resp)
}

// KnowledgeGapResponse 是知识缺口的接口表示。
type KnowledgeGapResponse struct {
	ID            string `json:"id"`
	Question      string `json:"question"`
	Source        string `json:"source"`
	Status        string `json:"status"`
	CreatedByType string `json:"created_by_type"`
	CreatedByID   string `json:"created_by_id"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

func knowledgeGapToResponse(g db.KnowledgeGap) KnowledgeGapResponse {
	return KnowledgeGapResponse{
		ID: uuidToString(g.ID), Question: g.Question, Source: g.Source, Status: g.Status,
		CreatedByType: g.CreatedByType, CreatedByID: uuidToString(g.CreatedByID),
		CreatedAt: timestampToString(g.CreatedAt), UpdatedAt: timestampToString(g.UpdatedAt),
	}
}

// recordKnowledgeGap 记录缺口；同一问题已有未补齐的缺口时直接返回它。
func (h *Handler) recordKnowledgeGap(ctx context.Context, workspaceID, question, source, actorType, actorID string) (KnowledgeGapResponse, error) {
	wsUUID := parseUUID(workspaceID)
	existing, err := h.Queries.FindOpenKnowledgeGap(ctx, db.FindOpenKnowledgeGapParams{WorkspaceID: wsUUID, Question: question})
	if err == nil {
		return knowledgeGapToResponse(existing), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return KnowledgeGapResponse{}, errors.Wrapf(err, "find knowledge gap workspace_id=%s", workspaceID)
	}
	gap, err := h.Queries.CreateKnowledgeGap(ctx, db.CreateKnowledgeGapParams{
		WorkspaceID: wsUUID, Question: question, Source: source, CreatedByType: actorType, CreatedByID: parseUUID(actorID),
	})
	if err != nil {
		return KnowledgeGapResponse{}, errors.Wrapf(err, "create knowledge gap workspace_id=%s", workspaceID)
	}

	return knowledgeGapToResponse(gap), nil
}

// ListKnowledgeGaps 列出知识缺口（GET /api/knowledge/gaps?status=）。
func (h *Handler) ListKnowledgeGaps(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	status := pgtype.Text{}
	if s := r.URL.Query().Get("status"); s != "" {
		if !validKnowledgeGapStatus(s) {
			writeError(w, http.StatusBadRequest, "invalid status")
			return
		}
		status = pgtype.Text{String: s, Valid: true}
	}

	gaps, err := h.Queries.ListKnowledgeGaps(r.Context(), db.ListKnowledgeGapsParams{WorkspaceID: parseUUID(workspaceID), Status: status})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge gaps")
		return
	}
	resp := make([]KnowledgeGapResponse, len(gaps))
	for i, g := range gaps {
		resp[i] = knowledgeGapToResponse(g)
	}

	writeJSON(w, http.StatusOK, resp)
}

func validKnowledgeGapStatus(s string) bool {
	return s == knowledgeGapOpen || s == knowledgeGapProcessing || s == knowledgeGapFilled
}

// CreateKnowledgeGap 记录一个知识缺口（POST /api/knowledge/gaps）。
func (h *Handler) CreateKnowledgeGap(w http.ResponseWriter, r *http.Request) {
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
	var req struct {
		Question string `json:"question"`
		Source   string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Question = strings.TrimSpace(req.Question)
	if req.Question == "" {
		writeError(w, http.StatusBadRequest, "question is required")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	source := req.Source
	if source == "" {
		source = knowledgeGapSearchMiss
		if actorType == "agent" {
			source = knowledgeGapAgent
		}
	}
	if source != knowledgeGapSearchMiss && source != knowledgeGapAgent {
		writeError(w, http.StatusBadRequest, "source must be search_miss or agent")
		return
	}

	gap, err := h.recordKnowledgeGap(r.Context(), workspaceID, req.Question, source, actorType, actorID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record knowledge gap")
		return
	}
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventGap, gap.ID)
	writeJSON(w, http.StatusCreated, gap)
}

// UpdateKnowledgeGap 修改缺口状态（PATCH /api/knowledge/gaps/{gapId}）。
func (h *Handler) UpdateKnowledgeGap(w http.ResponseWriter, r *http.Request) {
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
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "gapId"), "gap id")
	if !ok {
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validKnowledgeGapStatus(req.Status) {
		writeError(w, http.StatusBadRequest, "status must be open, processing or filled")
		return
	}

	gap, err := h.Queries.UpdateKnowledgeGapStatus(r.Context(), db.UpdateKnowledgeGapStatusParams{Status: req.Status, ID: id, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "knowledge gap not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to update knowledge gap")
		}
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventGap, uuidToString(gap.ID))
	writeJSON(w, http.StatusOK, knowledgeGapToResponse(gap))
}

// KnowledgeGraphResponse 是知识库的关系图。
type KnowledgeGraphResponse struct {
	Nodes []KnowledgeGraphNode  `json:"nodes"`
	Edges []knowledge.GraphEdge `json:"edges"`
}

// KnowledgeGraphNode 是关系图里的一个页面。
type KnowledgeGraphNode struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Group  string `json:"group"`
	Degree int    `json:"degree"`
}

// GetKnowledgeGraph 返回知识库页面之间的链接（GET /api/knowledge/bases/{id}/graph）。
func (h *Handler) GetKnowledgeGraph(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	corpus, err := h.loadKnowledgeCorpus(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	edges := corpus.Graph(kb.Slug)
	degree := map[string]int{}
	for _, e := range edges {
		degree[e.From]++
		degree[e.To]++
	}
	nodes := []KnowledgeGraphNode{}
	for _, p := range corpus.PagesOf(kb.Slug) {
		nodes = append(nodes, KnowledgeGraphNode{Path: p.Path, Title: p.Title, Group: knowledge.GroupOf(p.Path), Degree: degree[p.Path]})
	}
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Degree > nodes[j].Degree })
	if edges == nil {
		edges = []knowledge.GraphEdge{}
	}

	writeJSON(w, http.StatusOK, KnowledgeGraphResponse{Nodes: nodes, Edges: edges})
}
