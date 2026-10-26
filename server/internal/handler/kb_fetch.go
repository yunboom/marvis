package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// Search and list paging (GET /api/kb/search, claims, stale).
const (
	kbSearchDefaultLimit = 10
	kbSearchMaxLimit     = 50
	kbListDefaultLimit   = 50
	kbListMaxLimit       = 200
	// kbExcerptRunes is the length of a search hit excerpt.
	kbExcerptRunes = 120
	// kbSearchModeKeyword reports that only the keyword half of the hybrid
	// search ran; the vector half comes with ticket 06.
	kbSearchModeKeyword = "keyword"
	// kbLikeEscape escapes LIKE wildcards in search terms.
	kbLikeEscape = `\`
)

var kbLikeEscaper = strings.NewReplacer(kbLikeEscape, kbLikeEscape+kbLikeEscape, "%", kbLikeEscape+"%", "_", kbLikeEscape+"_")

// KbPageRefResponse is a page named next to another: a child or a backlink.
type KbPageRefResponse struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

// KbFetchResponse is a page read by scope (GET /api/kb/pages/{ref}/fetch).
// Content is set for detail=simple, Blocks for detail=with-ids; links are
// paths.
type KbFetchResponse struct {
	PageID      string               `json:"page_id"`
	Path        string               `json:"path"`
	Title       string               `json:"title"`
	Version     string               `json:"version"`
	Frontmatter map[string]any       `json:"frontmatter"`
	Content     *string              `json:"content,omitempty"`
	Blocks      *[]KbBlockResponse   `json:"blocks,omitempty"`
	Children    []KbPageRefResponse  `json:"children"`
	Backlinks   *[]KbPageRefResponse `json:"backlinks,omitempty"`
	Truncated   bool                 `json:"truncated"`
	Mention     string               `json:"mention"`
}

// KbPageClaimsResponse is the claims of one page.
type KbPageClaimsResponse struct {
	PageID  string     `json:"page_id"`
	Version string     `json:"version"`
	Claims  []kb.Claim `json:"claims"`
}

// KbClaimListItem is a claim found by evidence (GET /api/kb/bases/{kb}/claims).
type KbClaimListItem struct {
	PageID    string        `json:"page_id"`
	Path      string        `json:"path"`
	Key       string        `json:"key"`
	BlockID   string        `json:"block_id"`
	Text      string        `json:"text"`
	Evidence  []kb.Evidence `json:"evidence"`
	CheckedAt string        `json:"checked_at"`
}

// KbSearchHit is one page a search found.
type KbSearchHit struct {
	PageID  string `json:"page_id"`
	Slug    string `json:"slug"`
	Path    string `json:"path"`
	Title   string `json:"title"`
	Type    string `json:"type"`
	BlockID string `json:"block_id"`
	Excerpt string `json:"excerpt"`
	Mention string `json:"mention"`
}

// KbSearchResponse is a search result (GET /api/kb/search).
type KbSearchResponse struct {
	Mode string        `json:"mode"`
	Hits []KbSearchHit `json:"hits"`
}

// KbStalePage is a page past its review date (GET /api/kb/bases/{kb}/stale).
type KbStalePage struct {
	PageID     string `json:"page_id"`
	Path       string `json:"path"`
	Title      string `json:"title"`
	StaleAfter string `json:"stale_after"`
	Claims     int64  `json:"claims"`
	Mention    string `json:"mention"`
}

// FetchKbPage reads part of a page for an agent, like lark docs +fetch:
// ?scope picks the blocks, ?detail the shape, ?draft or ?revision_id the
// version. Links come back as paths.
func (h *Handler) FetchKbPage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()

	detail := query.Get("detail")
	if detail == "" {
		detail = kb.DetailSimple
	}
	if detail != kb.DetailSimple && detail != kb.DetailWithIDs {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "detail must be simple or with-ids")
		return
	}
	scope, ok := parseKbFetchScope(w, query)
	if !ok {
		return
	}
	revisionParam, draftParam := query.Get("revision_id"), query.Get("draft")
	if revisionParam != "" && draftParam != "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "revision_id and draft cannot be combined")
		return
	}

	page, ok := h.loadKbFetchPage(w, r, revisionParam, draftParam)
	if !ok {
		return
	}

	blocks := kb.PathLinks(page.blocks, page.overlay.tree)
	selected, truncated, err := kb.SelectBlocks(blocks, scope)
	switch {
	case errors.Is(err, kb.ErrBlockNotFound):
		writeErrorCode(w, http.StatusNotFound, kbCodeBlockNotFound, err.Error())
		return
	case errors.Is(err, kb.ErrInvalidFetch):
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, err.Error())
		return
	case err != nil:
		h.writeKbInternalError(w, r, err)
		return
	}

	title, _ := page.header[kb.MetaTitle].(string)
	path, _ := page.overlay.tree.PathByPageID(page.pageID)
	resp := KbFetchResponse{
		PageID:      page.pageID,
		Path:        path,
		Title:       title,
		Version:     page.version,
		Frontmatter: page.header,
		Children:    []KbPageRefResponse{},
		Truncated:   truncated,
		Mention:     pageMention(title, page.pageID),
	}
	if detail == kb.DetailSimple {
		content := kb.JoinBlocks(selected)
		resp.Content = &content
	} else {
		out := kbBlocksToResponse(selected)
		resp.Blocks = &out
	}
	for _, child := range page.overlay.siblings(page.pageID, "") {
		childPath, _ := page.overlay.tree.PathByPageID(child.ID)
		resp.Children = append(resp.Children, KbPageRefResponse{ID: child.ID, Path: childPath, Title: child.Title})
	}

	if query.Get("backlinks") == "true" {
		backlinks, err := h.kbBacklinks(ctx, page)
		if err != nil {
			h.writeKbInternalError(w, r, err)
			return
		}
		resp.Backlinks = &backlinks
	}

	writeJSON(w, http.StatusOK, resp)
}

func parseKbFetchScope(w http.ResponseWriter, query map[string][]string) (kb.FetchScope, bool) {
	get := func(key string) string {
		if v := query[key]; len(v) > 0 {
			return v[0]
		}

		return ""
	}
	ints := map[string]int{}
	for _, key := range []string{"context_before", "context_after", "max_depth"} {
		raw := get(key)
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, key+" must be a non-negative integer")
			return kb.FetchScope{}, false
		}
		ints[key] = n
	}

	return kb.FetchScope{
		Scope:         get("scope"),
		StartBlockID:  get("start_block_id"),
		EndBlockID:    get("end_block_id"),
		Keyword:       get("keyword"),
		ContextBefore: ints["context_before"],
		ContextAfter:  ints["context_after"],
		MaxDepth:      ints["max_depth"],
	}, true
}

// kbFetchPage is the page version a fetch reads.
type kbFetchPage struct {
	base    db.KbBase
	pageID  string
	version string
	header  map[string]any
	blocks  []kb.Block
	claims  []kb.Claim
	overlay kbOverlay
}

// loadKbFetchPage reads the page a fetch names: a past revision, the
// caller's draft copy, or the mainline.
func (h *Handler) loadKbFetchPage(w http.ResponseWriter, r *http.Request, revisionParam, draftParam string) (kbFetchPage, bool) {
	ctx := r.Context()

	if revisionParam != "" {
		wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
		if !ok {
			return kbFetchPage{}, false
		}
		revisionID, ok := parseUUIDOrBadRequest(w, revisionParam, "revision_id")
		if !ok {
			return kbFetchPage{}, false
		}
		base, pageID, ok := h.resolveKbPageRef(w, r, wsUUID, kbPageRefParam(r), nil)
		if !ok {
			return kbFetchPage{}, false
		}
		rev, err := h.Queries.GetKbPageRevision(ctx, db.GetKbPageRevisionParams{PageID: pageID, ID: revisionID})
		if err != nil {
			if isNotFound(err) {
				writeError(w, http.StatusNotFound, "revision not found")
				return kbFetchPage{}, false
			}
			h.writeKbInternalError(w, r, errors.Wrapf(err, "load revision revision_id=%s", revisionParam))
			return kbFetchPage{}, false
		}

		page, err := h.kbFetchPageFrom(ctx, base, pageID, revisionParam, rev.Frontmatter, rev.Blocks, rev.Claims, pgtype.UUID{})
		if err != nil {
			h.writeKbInternalError(w, r, err)
			return kbFetchPage{}, false
		}

		return page, true
	}

	src, ok := h.loadKbPageSource(w, r, kbPageRefParam(r), draftParam)
	if !ok {
		return kbFetchPage{}, false
	}
	var draftID pgtype.UUID
	if src.draft != nil {
		draftID = src.draft.ID
	}

	claims := src.draftClaims
	if claims == nil {
		mainClaims, err := h.loadKbMainlineClaims(ctx, src.base.ID, src.pageID)
		if err != nil {
			h.writeKbInternalError(w, r, err)
			return kbFetchPage{}, false
		}
		page, err := h.kbFetchPageFrom(ctx, src.base, src.pageID, src.version, src.header, src.blocks, nil, draftID)
		if err != nil {
			h.writeKbInternalError(w, r, err)
			return kbFetchPage{}, false
		}
		page.claims = mainClaims

		return page, true
	}

	page, err := h.kbFetchPageFrom(ctx, src.base, src.pageID, src.version, src.header, src.blocks, claims, draftID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return kbFetchPage{}, false
	}

	return page, true
}

func (h *Handler) kbFetchPageFrom(ctx context.Context, base db.KbBase, pageID pgtype.UUID, version string, rawHeader, rawBlocks, rawClaims []byte, draftID pgtype.UUID) (kbFetchPage, error) {
	id := uuidToString(pageID)
	header, _, err := kb.ParseFrontmatter(rawHeader)
	if err != nil {
		return kbFetchPage{}, errors.Wrapf(err, "page_id=%s", id)
	}
	blocks, err := kb.ParseBlocks(rawBlocks)
	if err != nil {
		return kbFetchPage{}, errors.Wrapf(err, "page_id=%s", id)
	}
	claims, err := kb.ParseClaims(rawClaims)
	if err != nil {
		return kbFetchPage{}, errors.Wrapf(err, "page_id=%s", id)
	}
	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, draftID)
	if err != nil {
		return kbFetchPage{}, err
	}

	return kbFetchPage{base: base, pageID: id, version: version, header: header, blocks: blocks, claims: claims, overlay: overlay}, nil
}

func (h *Handler) kbBacklinks(ctx context.Context, page kbFetchPage) ([]KbPageRefResponse, error) {
	rows, err := h.Queries.ListKbBacklinks(ctx, db.ListKbBacklinksParams{KnowledgeBaseID: page.base.ID, PageID: parseUUID(page.pageID)})
	if err != nil {
		return nil, errors.Wrapf(err, "list backlinks page_id=%s", page.pageID)
	}

	out := make([]KbPageRefResponse, 0, len(rows))
	for _, row := range rows {
		id := uuidToString(row.ID)
		path, _ := page.overlay.tree.PathByPageID(id)
		out = append(out, KbPageRefResponse{ID: id, Path: path, Title: row.Title})
	}

	return out, nil
}

// GetKbPageClaims returns the claims of a page, or of the caller's draft
// copy with ?draft (GET /api/kb/pages/{ref}/claims).
func (h *Handler) GetKbPageClaims(w http.ResponseWriter, r *http.Request) {
	page, ok := h.loadKbFetchPage(w, r, "", r.URL.Query().Get("draft"))
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, KbPageClaimsResponse{PageID: page.pageID, Version: page.version, Claims: page.claims})
}

// ListKbClaims finds claims by evidence uri prefix and check time, for
// health checks (GET /api/kb/bases/{kb}/claims).
func (h *Handler) ListKbClaims(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}
	limit, offset, ok := parseKbPaging(w, query.Get("limit"), query.Get("offset"), kbListDefaultLimit, kbListMaxLimit)
	if !ok {
		return
	}

	params := db.ListKbClaimsByEvidenceParams{KnowledgeBaseID: base.ID, RowLimit: int32(limit), RowOffset: int32(offset)}
	if evidence := query.Get("evidence"); evidence != "" {
		params.Evidence = pgtype.Text{String: evidence, Valid: true}
	}
	if raw := query.Get("checked_before"); raw != "" {
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "checked_before must be an RFC3339 time")
			return
		}
		params.CheckedBefore = pgtype.Timestamptz{Time: t, Valid: true}
	}

	rows, err := h.Queries.ListKbClaimsByEvidence(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list claims knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	tree, err := h.loadKbTree(ctx, base.ID, nil)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	claims, err := h.kbClaimRows(rows)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	out := make([]KbClaimListItem, len(rows))
	for i, row := range rows {
		pageID := uuidToString(row.PageID)
		path, _ := tree.PathByPageID(pageID)
		out[i] = KbClaimListItem{
			PageID:    pageID,
			Path:      path,
			Key:       claims[i].Key,
			BlockID:   claims[i].BlockID,
			Text:      claims[i].Text,
			Evidence:  claims[i].Evidence,
			CheckedAt: claims[i].CheckedAt,
		}
	}

	writeJSON(w, http.StatusOK, out)
}

// SearchKb runs a keyword search over page titles and text (GET
// /api/kb/search). Every space-separated term must match; ?kb narrows it to
// one knowledge base and ?type to one page type.
func (h *Handler) SearchKb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}

	terms := strings.Fields(strings.ToLower(query.Get("q")))
	if len(terms) == 0 {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "q is required")
		return
	}
	limit, offset, ok := parseKbPaging(w, query.Get("limit"), query.Get("offset"), kbSearchDefaultLimit, kbSearchMaxLimit)
	if !ok {
		return
	}

	params := db.SearchKbPagesParams{WorkspaceID: wsUUID, RowLimit: int32(limit), RowOffset: int32(offset)}
	if ref := query.Get("kb"); ref != "" {
		base, ok := h.loadKbBaseForUser(w, r, ref)
		if !ok {
			return
		}
		params.KnowledgeBaseID = base.ID
	}
	if pageType := query.Get("type"); pageType != "" {
		params.PageType = pgtype.Text{String: pageType, Valid: true}
	}
	for _, term := range terms {
		params.Patterns = append(params.Patterns, "%"+kbLikeEscaper.Replace(term)+"%")
	}

	rows, err := h.Queries.SearchKbPages(ctx, params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "search knowledge bases"))
		return
	}

	baseIDs := make([]pgtype.UUID, 0)
	seen := map[pgtype.UUID]bool{}
	for _, row := range rows {
		if !seen[row.KnowledgeBaseID] {
			seen[row.KnowledgeBaseID] = true
			baseIDs = append(baseIDs, row.KnowledgeBaseID)
		}
	}
	trees, err := h.loadKbTrees(ctx, baseIDs)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	resp := KbSearchResponse{Mode: kbSearchModeKeyword, Hits: make([]KbSearchHit, 0, len(rows))}
	for _, row := range rows {
		blocks, err := kb.ParseBlocks(row.Blocks)
		if err != nil {
			h.writeKbInternalError(w, r, errors.Wrapf(err, "page_id=%s", uuidToString(row.ID)))
			return
		}
		id := uuidToString(row.ID)
		tree := trees[row.KnowledgeBaseID]
		path, _ := tree.PathByPageID(id)
		blockID, excerpt := kbSearchExcerpt(kb.PathLinks(blocks, tree), terms)
		resp.Hits = append(resp.Hits, KbSearchHit{
			PageID:  id,
			Slug:    row.KbSlug,
			Path:    path,
			Title:   row.Title,
			Type:    row.Type,
			BlockID: blockID,
			Excerpt: excerpt,
			Mention: pageMention(row.Title, id),
		})
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) loadKbTrees(ctx context.Context, baseIDs []pgtype.UUID) (map[pgtype.UUID]*kb.PageTree, error) {
	out := make(map[pgtype.UUID]*kb.PageTree, len(baseIDs))
	if len(baseIDs) == 0 {
		return out, nil
	}

	rows, err := h.Queries.ListKbPageTreesByBases(ctx, baseIDs)
	if err != nil {
		return nil, errors.Wrap(err, "list page trees")
	}
	nodes := make(map[pgtype.UUID][]kb.TreeNode, len(baseIDs))
	for _, row := range rows {
		nodes[row.KnowledgeBaseID] = append(nodes[row.KnowledgeBaseID], kb.TreeNode{
			ID: uuidToString(row.ID), ParentID: uuidOrEmpty(row.ParentID), Slug: row.Slug, Title: row.Title, Position: row.Position,
		})
	}
	for _, id := range baseIDs {
		out[id] = kb.NewPageTree(nodes[id])
	}

	return out, nil
}

// kbSearchExcerpt picks the first block whose text matches a term and cuts
// an excerpt around the match.
func kbSearchExcerpt(blocks []kb.Block, terms []string) (string, string) {
	for _, block := range blocks {
		plain := kb.PlainText(block.Content)
		lower := strings.ToLower(plain)
		for _, term := range terms {
			i := strings.Index(lower, term)
			if i < 0 {
				continue
			}

			return block.ID, excerptAround(plain, i)
		}
	}

	return "", ""
}

func excerptAround(text string, byteIndex int) string {
	start := byteIndex
	for back := 0; start > 0 && back < kbExcerptRunes/4; back++ {
		_, size := utf8.DecodeLastRuneInString(text[:start])
		start -= size
	}

	runes := []rune(text[start:])
	excerpt := string(runes[:min(len(runes), kbExcerptRunes)])
	if start > 0 {
		excerpt = "…" + excerpt
	}
	if len(runes) > kbExcerptRunes {
		excerpt += "…"
	}

	return excerpt
}

// ListKbStalePages lists pages past their stale_after, oldest first (GET
// /api/kb/bases/{kb}/stale).
func (h *Handler) ListKbStalePages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}
	limit, offset, ok := parseKbPaging(w, query.Get("limit"), query.Get("offset"), kbListDefaultLimit, kbListMaxLimit)
	if !ok {
		return
	}

	rows, err := h.Queries.ListKbStalePages(ctx, db.ListKbStalePagesParams{KnowledgeBaseID: base.ID, RowLimit: int32(limit), RowOffset: int32(offset)})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list stale pages knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	tree, err := h.loadKbTree(ctx, base.ID, nil)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	out := make([]KbStalePage, 0, len(rows))
	for _, row := range rows {
		id := uuidToString(row.ID)
		path, _ := tree.PathByPageID(id)
		out = append(out, KbStalePage{
			PageID:     id,
			Path:       path,
			Title:      row.Title,
			StaleAfter: timestampToString(row.StaleAfter),
			Claims:     row.ClaimCount,
			Mention:    pageMention(row.Title, id),
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// kbClaimRows decodes kb_claim rows.
func (h *Handler) kbClaimRows(rows []db.KbClaim) ([]kb.Claim, error) {
	out := make([]kb.Claim, len(rows))
	for i, row := range rows {
		evidence := []kb.Evidence{}
		if err := json.Unmarshal(row.Evidence, &evidence); err != nil {
			return nil, errors.Wrapf(err, "decode evidence claim_id=%s", uuidToString(row.ID))
		}
		out[i] = kb.Claim{
			Key:       row.Key,
			BlockID:   row.BlockID,
			Text:      row.Text,
			Evidence:  evidence,
			CheckedAt: timestampToString(row.CheckedAt),
		}
	}

	return out, nil
}

// parseKbPaging reads limit and offset with a default and a cap.
func parseKbPaging(w http.ResponseWriter, rawLimit, rawOffset string, defaultLimit, maxLimit int) (int, int, bool) {
	limit := defaultLimit
	if rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 || n > maxLimit {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "limit must be between 1 and "+strconv.Itoa(maxLimit))
			return 0, 0, false
		}
		limit = n
	}

	offset := 0
	if rawOffset != "" {
		n, err := strconv.Atoi(rawOffset)
		if err != nil || n < 0 {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "offset must be a non-negative integer")
			return 0, 0, false
		}
		offset = n
	}

	return limit, offset, true
}
