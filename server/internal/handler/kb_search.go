package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const (
	// kbExcerptRunes is the length of a search hit excerpt.
	kbExcerptRunes = 120
	// kbLikeEscape escapes LIKE wildcards in search terms.
	kbLikeEscape = `\`
	// kbQueryEmbedTimeout bounds embedding the query (spec 07.7); past it the
	// search falls back to keyword only.
	kbQueryEmbedTimeout = 2 * time.Second
	// kbVectorMaxDistance drops vector hits farther than this cosine distance
	// (similarity below 0.35), so an unrelated query can still find nothing.
	kbVectorMaxDistance = 0.65
	// kbSetIterativeScan lets HNSW keep scanning when filters drop rows
	// (pgvector README, "Iterative Index Scans").
	kbSetIterativeScan = "SET LOCAL hnsw.iterative_scan = relaxed_order"
)

var kbLikeEscaper = strings.NewReplacer(kbLikeEscape, kbLikeEscape+kbLikeEscape, "%", kbLikeEscape+"%", "_", kbLikeEscape+"_")

// KbSearchHit is one page a search found.
type KbSearchHit struct {
	PageID string `json:"page_id"`
	Slug   string `json:"slug"`
	Path   string `json:"path"`
	// Parents are the titles of the pages above, top level first.
	Parents []string `json:"parents"`
	Title   string   `json:"title"`
	Type    string   `json:"type"`
	BlockID string   `json:"block_id"`
	Excerpt string   `json:"excerpt"`
	// Score is the RRF score, only meaningful for ordering.
	Score   float64 `json:"score"`
	Mention string  `json:"mention"`
}

// KbSearchResponse is a search result (GET /api/kb/search). Mode is hybrid
// when the vector half ran, keyword otherwise; Total counts every page found,
// beyond the hits returned.
type KbSearchResponse struct {
	Mode  string        `json:"mode"`
	Hits  []KbSearchHit `json:"hits"`
	Total int64         `json:"total"`
}

// kbSearchQuery is a parsed search request.
type kbSearchQuery struct {
	workspaceID pgtype.UUID
	baseID      pgtype.UUID
	pageType    pgtype.Text
	text        string
	terms       []string
	patterns    []string
	limit       int
}

// kbSearchPage is a page a search hit points at.
type kbSearchPage struct {
	baseID pgtype.UUID
	slug   string
	title  string
	typ    string
	blocks []byte
}

// SearchKb runs hybrid search over mainline pages (GET /api/kb/search): a
// keyword half (every space-separated term must match the title or text,
// title hits first) and a vector half (nearest blocks by embedding), each
// contributing its top 50 blocks, fused with RRF and grouped by page. The top
// ?limit pages (1-50) come back with the total, without paging; ?type and ?kb
// narrow both halves. Without an embedding model or pgvector, or when the
// vector half fails, it is keyword only.
func (h *Handler) SearchKb(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}

	text := strings.TrimSpace(query.Get("q"))
	terms := strings.Fields(strings.ToLower(text))
	if len(terms) == 0 {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "q is required")
		return
	}
	limit, _, ok := parseKbPaging(w, query.Get("limit"), "", kbSearchDefaultLimit, kbSearchMaxLimit)
	if !ok {
		return
	}

	var baseID pgtype.UUID
	if ref := query.Get("kb"); ref != "" {
		base, ok := h.loadKbBaseForUser(w, r, ref)
		if !ok {
			return
		}
		baseID = base.ID
	}

	patterns := make([]string, len(terms))
	for i, term := range terms {
		patterns[i] = "%" + kbLikeEscaper.Replace(term) + "%"
	}
	pageType := strings.TrimSpace(query.Get("type"))

	resp, err := h.searchKb(r.Context(), kbSearchQuery{
		workspaceID: wsUUID,
		baseID:      baseID,
		pageType:    pgtype.Text{String: pageType, Valid: pageType != ""},
		text:        text,
		terms:       terms,
		patterns:    patterns,
		limit:       limit,
	})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) searchKb(ctx context.Context, q kbSearchQuery) (KbSearchResponse, error) {
	keywordRows, err := h.Queries.SearchKbPages(ctx, db.SearchKbPagesParams{
		WorkspaceID: q.workspaceID, KnowledgeBaseID: q.baseID, PageType: q.pageType, Patterns: q.patterns, RowLimit: kb.SearchDepth,
	})
	if err != nil {
		return KbSearchResponse{}, errors.Wrap(err, "search knowledge bases")
	}
	keywordTotal, err := h.Queries.CountKbSearchPages(ctx, db.CountKbSearchPagesParams{
		WorkspaceID: q.workspaceID, KnowledgeBaseID: q.baseID, PageType: q.pageType, Patterns: q.patterns,
	})
	if err != nil {
		return KbSearchResponse{}, errors.Wrap(err, "count search hits")
	}

	mode := kb.SearchModeKeyword
	vectorList, vectorErr := h.searchKbVector(ctx, q)
	switch {
	case vectorErr != nil:
		// Degrading to keyword is the handling; keep a trace for operators.
		slog.Warn("kb search vector half failed, keyword only", "error", fmt.Sprintf("%+v", vectorErr))
	case vectorList != nil:
		mode = kb.SearchModeHybrid
	}

	pages := make(map[string]kbSearchPage, len(keywordRows))
	keywordList := make([]kb.RankedBlock, 0, len(keywordRows))
	vectorRank := kbVectorRanks(vectorList)
	for _, row := range keywordRows {
		id := uuidToString(row.ID)
		pages[id] = kbSearchPage{baseID: row.KnowledgeBaseID, slug: row.KbSlug, title: row.Title, typ: row.Type, blocks: row.Blocks}
		blockID, err := kbKeywordBlock(row.Blocks, q.terms, vectorRank[id])
		if err != nil {
			return KbSearchResponse{}, errors.Wrapf(err, "page_id=%s", id)
		}
		keywordList = append(keywordList, kb.RankedBlock{PageID: id, BlockID: blockID})
	}

	fused := kb.FuseRRF(keywordList, vectorList)
	total, err := h.kbSearchTotal(ctx, q, keywordTotal, len(keywordRows), pages, vectorList)
	if err != nil {
		return KbSearchResponse{}, err
	}

	top := fused[:min(len(fused), q.limit)]
	if err := h.loadKbSearchPages(ctx, top, pages); err != nil {
		return KbSearchResponse{}, err
	}

	hits, err := h.kbSearchHits(ctx, top, pages, q.terms)
	if err != nil {
		return KbSearchResponse{}, err
	}

	return KbSearchResponse{Mode: mode, Hits: hits, Total: total}, nil
}

// searchKbVector runs the vector half. It returns nil without an error when
// the half is off (no model, no pgvector), so the caller knows to report
// keyword mode; an error means it was on and failed.
func (h *Handler) searchKbVector(ctx context.Context, q kbSearchQuery) ([]kb.RankedBlock, error) {
	if h.KbEmbedder == nil || !h.KbEmbedder.Enabled() {
		return nil, nil
	}
	present, err := h.Queries.KbBlockEmbeddingTableExists(ctx)
	if err != nil {
		return nil, errors.Wrap(err, "check kb_block_embedding")
	}
	if !present {
		return nil, nil
	}

	embedCtx, cancel := context.WithTimeout(ctx, kbQueryEmbedTimeout)
	vectors, err := h.KbEmbedder.Embed(embedCtx, []string{q.text})
	cancel()
	if err != nil {
		return nil, errors.Wrap(err, "embed search query")
	}
	if len(vectors) != 1 {
		return nil, errors.Errorf("embed search query: got %d vectors", len(vectors))
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, errors.Wrap(err, "begin vector search")
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, kbSetIterativeScan); err != nil {
		return nil, errors.Wrap(err, "enable iterative scan")
	}
	rows, err := h.Queries.WithTx(tx).SearchKbBlockEmbeddings(ctx, db.SearchKbBlockEmbeddingsParams{
		MaxDistance:     kbVectorMaxDistance,
		Query:           kb.VectorText(vectors[0]),
		WorkspaceID:     q.workspaceID,
		Model:           h.KbEmbedder.Model(),
		KnowledgeBaseID: q.baseID,
		PageType:        q.pageType,
		RowLimit:        kb.SearchDepth,
	})
	if err != nil {
		return nil, errors.Wrap(err, "vector search")
	}

	list := make([]kb.RankedBlock, len(rows))
	for i, row := range rows {
		list[i] = kb.RankedBlock{PageID: uuidToString(row.PageID), BlockID: row.BlockID}
	}

	return list, nil
}

// kbVectorRanks indexes the vector half: page -> block -> rank (0-based).
func kbVectorRanks(list []kb.RankedBlock) map[string]map[string]int {
	out := map[string]map[string]int{}
	for i, entry := range list {
		blocks := out[entry.PageID]
		if blocks == nil {
			blocks = map[string]int{}
			out[entry.PageID] = blocks
		}
		if _, ok := blocks[entry.BlockID]; !ok {
			blocks[entry.BlockID] = i
		}
	}

	return out
}

// kbKeywordBlock picks the block that represents a keyword hit: among the
// blocks containing a term, the one the vector half ranks best, so a block
// both halves found scores both; otherwise the first. Empty when only the
// title matched.
func kbKeywordBlock(raw []byte, terms []string, vectorRank map[string]int) (string, error) {
	blocks, err := kb.ParseBlocks(raw)
	if err != nil {
		return "", err
	}

	first, best, bestRank := "", "", -1
	for _, block := range blocks {
		if !kbContainsTerm(strings.ToLower(kb.PlainText(block.Content)), terms) {
			continue
		}
		if first == "" {
			first = block.ID
		}
		if rank, ok := vectorRank[block.ID]; ok && (bestRank < 0 || rank < bestRank) {
			best, bestRank = block.ID, rank
		}
	}
	if best != "" {
		return best, nil
	}

	return first, nil
}

func kbContainsTerm(lower string, terms []string) bool {
	for _, term := range terms {
		if strings.Contains(lower, term) {
			return true
		}
	}

	return false
}

// kbSearchTotal counts the pages found: every keyword match plus the vector
// hits the keyword half did not match.
func (h *Handler) kbSearchTotal(ctx context.Context, q kbSearchQuery, keywordTotal int64, keywordFetched int, keywordPages map[string]kbSearchPage, vectorList []kb.RankedBlock) (int64, error) {
	extra := make([]pgtype.UUID, 0)
	seen := map[string]bool{}
	for _, entry := range vectorList {
		if _, ok := keywordPages[entry.PageID]; ok || seen[entry.PageID] {
			continue
		}
		seen[entry.PageID] = true
		extra = append(extra, parseUUID(entry.PageID))
	}
	if len(extra) == 0 {
		return keywordTotal, nil
	}

	// When the keyword half returned every match, a page it did not return
	// does not match; otherwise ask which of the extra pages do.
	matched := 0
	if keywordTotal > int64(keywordFetched) {
		ids, err := h.Queries.ListKbPageIDsMatchingSearch(ctx, db.ListKbPageIDsMatchingSearchParams{PageIds: extra, Patterns: q.patterns})
		if err != nil {
			return 0, errors.Wrap(err, "match vector hits against keywords")
		}
		matched = len(ids)
	}

	return keywordTotal + int64(len(extra)-matched), nil
}

// loadKbSearchPages adds the pages of vector-only hits to pages.
func (h *Handler) loadKbSearchPages(ctx context.Context, top []kb.FusedPage, pages map[string]kbSearchPage) error {
	missing := make([]pgtype.UUID, 0)
	for _, hit := range top {
		if _, ok := pages[hit.PageID]; !ok {
			missing = append(missing, parseUUID(hit.PageID))
		}
	}
	if len(missing) == 0 {
		return nil
	}

	rows, err := h.Queries.ListKbPagesForSearchHits(ctx, missing)
	if err != nil {
		return errors.Wrapf(err, "load search hit pages=%d", len(missing))
	}
	for _, row := range rows {
		pages[uuidToString(row.ID)] = kbSearchPage{baseID: row.KnowledgeBaseID, slug: row.KbSlug, title: row.Title, typ: row.Type, blocks: row.Blocks}
	}

	return nil
}

func (h *Handler) kbSearchHits(ctx context.Context, top []kb.FusedPage, pages map[string]kbSearchPage, terms []string) ([]KbSearchHit, error) {
	baseIDs := make([]pgtype.UUID, 0)
	seen := map[pgtype.UUID]bool{}
	for _, hit := range top {
		page, ok := pages[hit.PageID]
		if ok && !seen[page.baseID] {
			seen[page.baseID] = true
			baseIDs = append(baseIDs, page.baseID)
		}
	}
	trees, err := h.loadKbTrees(ctx, baseIDs)
	if err != nil {
		return nil, err
	}

	hits := make([]KbSearchHit, 0, len(top))
	for _, hit := range top {
		// A page deleted between the two halves has no row; skip it.
		page, ok := pages[hit.PageID]
		if !ok {
			continue
		}
		blocks, err := kb.ParseBlocks(page.blocks)
		if err != nil {
			return nil, errors.Wrapf(err, "page_id=%s", hit.PageID)
		}

		tree := trees[page.baseID]
		path, _ := tree.PathByPageID(hit.PageID)
		ancestors := tree.Ancestors(hit.PageID)
		parents := make([]string, len(ancestors))
		for i, node := range ancestors {
			parents[i] = node.Title
		}
		blockID, excerpt := kbHitExcerpt(kb.PathLinks(blocks, tree), hit.BlockID, terms)

		hits = append(hits, KbSearchHit{
			PageID: hit.PageID, Slug: page.slug, Path: path, Parents: parents, Title: page.title, Type: page.typ,
			BlockID: blockID, Excerpt: excerpt, Score: hit.Score, Mention: pageMention(page.title, hit.PageID),
		})
	}

	return hits, nil
}

// kbHitExcerpt cuts the excerpt of a hit from its block, around the first
// term when the block has one. A title-only hit falls back to the first
// block containing a term.
func kbHitExcerpt(blocks []kb.Block, blockID string, terms []string) (string, string) {
	if blockID == "" {
		return kbSearchExcerpt(blocks, terms)
	}

	for _, block := range blocks {
		if block.ID != blockID {
			continue
		}
		plain := kb.PlainText(block.Content)
		at := 0
		lower := strings.ToLower(plain)
		for _, term := range terms {
			if i := strings.Index(lower, term); i >= 0 {
				at = i
				break
			}
		}

		return block.ID, excerptAround(plain, at)
	}

	return kbSearchExcerpt(blocks, terms)
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
