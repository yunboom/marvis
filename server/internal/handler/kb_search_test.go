package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/embedding"
)

// kbStubEmbedder maps text to one of three orthogonal "concepts", so tests
// control which blocks are near a query. It never leaves the process.
type kbStubEmbedder struct {
	model string
	err   error

	mu     sync.Mutex
	inputs []string
}

func (s *kbStubEmbedder) Enabled() bool { return true }

func (s *kbStubEmbedder) Model() string { return s.model }

func (s *kbStubEmbedder) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	if s.err != nil {
		return nil, s.err
	}
	if len(inputs) > embedding.MaxBatchSize {
		return nil, errors.Errorf("batch of %d", len(inputs))
	}

	s.mu.Lock()
	s.inputs = append(s.inputs, inputs...)
	s.mu.Unlock()

	out := make([][]float32, len(inputs))
	for i, text := range inputs {
		v := make([]float32, embedding.Dimensions)
		lower := strings.ToLower(text)
		switch {
		case strings.Contains(lower, "idempot") || strings.Contains(lower, "duplicate"):
			v[0] = 1
		case strings.Contains(lower, "retry"):
			v[1] = 1
		default:
			v[2] = 1
		}
		out[i] = v
	}

	return out, nil
}

func (s *kbStubEmbedder) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.inputs)
}

// requireKbVectors skips when pgvector is not installed here; the vector half
// cannot run without kb_block_embedding.
func requireKbVectors(t *testing.T) {
	t.Helper()

	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	present, err := testHandler.Queries.KbBlockEmbeddingTableExists(context.Background())
	if err != nil {
		t.Fatalf("check kb_block_embedding: %v", err)
	}
	if !present {
		t.Skip("pgvector not installed: kb_block_embedding is missing (migration 606 skipped)")
	}
}

// useKbEmbedder swaps the handler's query embedder for the test.
func useKbEmbedder(t *testing.T, e kb.Embedder) {
	t.Helper()

	previous := testHandler.KbEmbedder
	testHandler.KbEmbedder = e
	t.Cleanup(func() { testHandler.KbEmbedder = previous })
}

type kbSearchFixture struct {
	slug                    string
	baseID                  string
	dedup, retry, unrelated string
}

func newKbSearchFixture(t *testing.T) kbSearchFixture {
	t.Helper()

	slug := fmt.Sprintf("search-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Search KB", slug)
	dbfx.Cleanup(t, `DELETE FROM kb_block_embedding WHERE knowledge_base_id = $1`, base)

	parent := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "Payment", Position: "a0", Markdown: "Payment notes."})
	f := kbSearchFixture{slug: slug, baseID: base}
	f.dedup = createTestKbPage(t, base, kb.NewPage{
		Slug: "callback", Title: "Callback", Type: "Workflow", Position: "a0", ParentID: parent,
		Markdown: "# Callback\n\nChannels call back twice.\n\nThe idempotency key drops repeats.",
	})
	f.retry = createTestKbPage(t, base, kb.NewPage{Slug: "retry", Title: "Retry policy", Position: "a1", Markdown: "Webhook retry backs off."})
	f.unrelated = createTestKbPage(t, base, kb.NewPage{Slug: "lunch", Title: "Lunch", Position: "a2", Markdown: "Noodles on Friday."})

	return f
}

func (f kbSearchFixture) pageIDs() []pgtype.UUID {
	return []pgtype.UUID{parseUUID(f.dedup), parseUUID(f.retry), parseUUID(f.unrelated)}
}

func searchKb(t *testing.T, query string) KbSearchResponse {
	t.Helper()

	var resp KbSearchResponse
	req := newRequest(http.MethodGet, "/api/kb/search?"+query, nil)
	testutil.Call(t, testHandler.SearchKb, req).Want(http.StatusOK).JSON(&resp)

	return resp
}

func countKbEmbeddings(t *testing.T, pageID string) int {
	t.Helper()

	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM kb_block_embedding WHERE page_id = $1`, pageID).Scan(&n)

	return n
}

func TestKbEmbeddingIndexerDedupesAndFollowsModel(t *testing.T) {
	requireKbVectors(t)

	ctx := context.Background()
	f := newKbSearchFixture(t)
	stub := &kbStubEmbedder{model: "stub-a"}
	indexer := kb.NewEmbeddingIndexer(testHandler.Queries, stub)

	if err := indexer.IndexPages(ctx, f.pageIDs()); err != nil {
		t.Fatalf("index: %+v", err)
	}
	// Callback has three blocks with text (heading, two paragraphs).
	if n := countKbEmbeddings(t, f.dedup); n != 3 {
		t.Errorf("callback embeddings = %d", n)
	}
	first := stub.calls()

	// Unchanged blocks are not re-embedded.
	if err := indexer.IndexPages(ctx, f.pageIDs()); err != nil {
		t.Fatalf("reindex: %+v", err)
	}
	if stub.calls() != first {
		t.Errorf("reindex embedded %d more blocks", stub.calls()-first)
	}

	// A changed block is re-embedded alone; a removed one loses its vector.
	dbfx.Exec(t, `UPDATE kb_page SET blocks = '[{"id":"b001","kind":"text","content":"Retry twice."}]', updated_at = now() WHERE id = $1`, f.retry)
	if err := indexer.IndexPages(ctx, []pgtype.UUID{parseUUID(f.retry)}); err != nil {
		t.Fatalf("index changed page: %+v", err)
	}
	if stub.calls() != first+1 || countKbEmbeddings(t, f.retry) != 1 {
		t.Errorf("changed page: calls +%d, rows %d", stub.calls()-first, countKbEmbeddings(t, f.retry))
	}

	// Deleted pages lose their vectors.
	dbfx.Exec(t, `UPDATE kb_page SET deleted_at = now() WHERE id = $1`, f.unrelated)
	if err := indexer.IndexPages(ctx, []pgtype.UUID{parseUUID(f.unrelated)}); err != nil {
		t.Fatalf("index deleted page: %+v", err)
	}
	if n := countKbEmbeddings(t, f.unrelated); n != 0 {
		t.Errorf("deleted page keeps %d embeddings", n)
	}

	// A new model makes the backfill re-embed what the old one indexed.
	next := &kbStubEmbedder{model: "stub-b"}
	if err := kb.NewEmbeddingIndexer(testHandler.Queries, next).Backfill(ctx); err != nil {
		t.Fatalf("backfill: %+v", err)
	}
	var models []string
	rows, err := testPool.Query(ctx, `SELECT DISTINCT model FROM kb_block_embedding WHERE knowledge_base_id = $1`, f.baseID)
	if err != nil {
		t.Fatalf("models: %v", err)
	}
	for rows.Next() {
		var m string
		_ = rows.Scan(&m)
		models = append(models, m)
	}
	rows.Close()
	if len(models) != 1 || models[0] != "stub-b" {
		t.Errorf("models after backfill = %v", models)
	}
}

func TestKbSearchHybrid(t *testing.T) {
	requireKbVectors(t)

	f := newKbSearchFixture(t)
	stub := &kbStubEmbedder{model: "stub-hybrid"}
	if err := kb.NewEmbeddingIndexer(testHandler.Queries, stub).IndexPages(context.Background(), f.pageIDs()); err != nil {
		t.Fatalf("index: %+v", err)
	}
	useKbEmbedder(t, stub)

	// No keyword matches "duplicate requests"; the vector half finds the
	// idempotency block.
	got := searchKb(t, "q="+url.QueryEscape("duplicate requests")+"&kb="+f.slug)
	if got.Mode != kb.SearchModeHybrid || got.Total != 1 || len(got.Hits) != 1 {
		t.Fatalf("vector only = %+v", got)
	}
	hit := got.Hits[0]
	if hit.PageID != f.dedup || hit.Path != "/payment/callback" || len(hit.Parents) != 1 || hit.Parents[0] != "Payment" ||
		!strings.Contains(hit.Excerpt, "idempotency") || hit.Score <= 0 || hit.Mention == "" {
		t.Errorf("vector hit = %+v", hit)
	}

	// Found by both halves, a block scores both ranks.
	got = searchKb(t, "q=retry&kb="+f.slug)
	if got.Mode != kb.SearchModeHybrid || len(got.Hits) != 1 || got.Hits[0].PageID != f.retry || got.Hits[0].Score <= 1.0/float64(kb.RRFK+1) {
		t.Errorf("both halves = %+v", got)
	}

	// The type filter applies to the vector half too.
	got = searchKb(t, "q="+url.QueryEscape("duplicate requests")+"&type=guide&kb="+f.slug)
	if len(got.Hits) != 0 || got.Total != 0 {
		t.Errorf("type filter = %+v", got)
	}
	got = searchKb(t, "q="+url.QueryEscape("duplicate requests")+"&type=workflow&kb="+f.slug)
	if len(got.Hits) != 1 {
		t.Errorf("type filter keeps the match = %+v", got)
	}

	// Total is the union of both halves: "back" matches two pages by keyword
	// and the stub puts lunch near it too; limit caps the hits only.
	got = searchKb(t, "q=back&kb="+f.slug+"&limit=1")
	if len(got.Hits) != 1 || got.Total != 3 {
		t.Errorf("limit = %+v", got)
	}
}

func TestKbSearchFallsBackToKeyword(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbSearchFixture(t)

	// No embedding model configured.
	useKbEmbedder(t, embedding.New(embedding.Config{}))
	got := searchKb(t, "q=retry&kb="+f.slug)
	if got.Mode != kb.SearchModeKeyword || len(got.Hits) != 1 || got.Hits[0].PageID != f.retry || got.Total != 1 || got.Hits[0].Score <= 0 {
		t.Errorf("unconfigured = %+v", got)
	}

	// The embedding call fails.
	testHandler.KbEmbedder = &kbStubEmbedder{model: "stub", err: errors.New("upstream down")}
	got = searchKb(t, "q=retry&kb="+f.slug)
	if got.Mode != kb.SearchModeKeyword || len(got.Hits) != 1 {
		t.Errorf("embedding error = %+v", got)
	}
}

func TestKbSearchFallsBackWithoutPgvector(t *testing.T) {
	requireKbVectors(t)

	ctx := context.Background()
	f := newKbSearchFixture(t)

	// Hide kb_block_embedding inside a transaction nobody else sees; the
	// handler copy reads through it.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `ALTER TABLE kb_block_embedding RENAME TO kb_block_embedding_hidden`); err != nil {
		t.Fatalf("hide table: %v", err)
	}

	h := *testHandler
	h.Queries = db.New(tx)
	h.KbEmbedder = &kbStubEmbedder{model: "stub"}

	var got KbSearchResponse
	req := newRequest(http.MethodGet, "/api/kb/search?q=retry&kb="+f.slug, nil)
	testutil.Call(t, h.SearchKb, req).Want(http.StatusOK).JSON(&got)
	if got.Mode != kb.SearchModeKeyword || len(got.Hits) != 1 {
		t.Errorf("without pgvector = %+v", got)
	}
}
