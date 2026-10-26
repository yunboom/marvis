package kb

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/embedding"
)

// Embedder turns texts into vectors; *embedding.Client implements it.
type Embedder interface {
	Enabled() bool
	Model() string
	// BatchSize is the most inputs one Embed call takes.
	BatchSize() int
	Embed(ctx context.Context, inputs []string) ([][]float32, error)
}

const (
	// embedInputRunes caps the text sent for one block, well inside the
	// context window of the 1024-dimension models spec 07.7 names.
	embedInputRunes = 4000
	// backfillPageBatch is how many pages one backfill step indexes.
	backfillPageBatch = 100
	// sweepInterval is how often the indexer re-runs the backfill, catching
	// pages whose enqueue was lost (for example to a restart).
	sweepInterval = 10 * time.Minute
	// minRetryDelay and maxRetryDelay bound the exponential backoff after a
	// failed indexing step.
	minRetryDelay = 2 * time.Second
	maxRetryDelay = 5 * time.Minute
)

// EmbeddingIndexer keeps kb_block_embedding in step with the mainline. Writes
// to the mainline call Enqueue after their transaction commits; Run indexes
// the queue in the background, back-fills pages that have no vectors of the
// configured model (first configuration, model change) and retries failures
// with exponential backoff. Drafts are never indexed.
type EmbeddingIndexer struct {
	queries  *db.Queries
	embedder Embedder

	mu      sync.Mutex
	pending map[pgtype.UUID]struct{}
	wake    chan struct{}
}

// NewEmbeddingIndexer builds an indexer; it is inert when the embedder is
// disabled.
func NewEmbeddingIndexer(queries *db.Queries, embedder Embedder) *EmbeddingIndexer {
	return &EmbeddingIndexer{
		queries:  queries,
		embedder: embedder,
		pending:  map[pgtype.UUID]struct{}{},
		wake:     make(chan struct{}, 1),
	}
}

// Enabled reports whether an embedding model is configured.
func (x *EmbeddingIndexer) Enabled() bool {
	return x != nil && x.embedder != nil && x.embedder.Enabled()
}

// Enqueue schedules pages for (re)indexing, deleted ones included. Call it
// after the transaction that changed the mainline commits; it never blocks.
func (x *EmbeddingIndexer) Enqueue(pageIDs ...pgtype.UUID) {
	if !x.Enabled() || len(pageIDs) == 0 {
		return
	}

	x.mu.Lock()
	for _, id := range pageIDs {
		if id.Valid {
			x.pending[id] = struct{}{}
		}
	}
	x.mu.Unlock()

	select {
	case x.wake <- struct{}{}:
	default:
	}
}

func (x *EmbeddingIndexer) takePending() []pgtype.UUID {
	x.mu.Lock()
	defer x.mu.Unlock()

	ids := make([]pgtype.UUID, 0, len(x.pending))
	for id := range x.pending {
		ids = append(ids, id)
	}
	x.pending = map[pgtype.UUID]struct{}{}

	return ids
}

// Run indexes until ctx is done. It returns at once when no model is
// configured or the database has no pgvector.
func (x *EmbeddingIndexer) Run(ctx context.Context) {
	if !x.Enabled() {
		return
	}
	present, err := x.queries.KbBlockEmbeddingTableExists(ctx)
	if err != nil {
		slog.Error("kb embedding indexer stopped", "error", err)
		return
	}
	if !present {
		slog.Info("kb embedding indexer off: pgvector is not installed")
		return
	}

	backoff := newBackoff()
	backfillDue := true
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()

	for {
		if backfillDue {
			if err := x.Backfill(ctx); err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.Warn("kb embedding backfill failed", "error", err)
				if !backoff.wait(ctx) {
					return
				}
				continue
			}
			backfillDue = false
			backoff.reset()
		}

		if ids := x.takePending(); len(ids) > 0 {
			if err := x.IndexPages(ctx, ids); err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.Warn("kb embedding indexing failed", "pages", len(ids), "error", err)
				x.Enqueue(ids...)
				if !backoff.wait(ctx) {
					return
				}
				continue
			}
			backoff.reset()
		}

		select {
		case <-ctx.Done():
			return
		case <-x.wake:
		case <-ticker.C:
			backfillDue = true
		}
	}
}

// Backfill indexes every live page that lacks vectors of the configured model
// or changed since it was indexed, in batches, and drops the vectors of
// deleted pages.
func (x *EmbeddingIndexer) Backfill(ctx context.Context) error {
	if err := x.queries.DeleteKbBlockEmbeddingsOfDeletedPages(ctx); err != nil {
		return errors.Wrap(err, "delete embeddings of deleted pages")
	}

	after := pgtype.UUID{Valid: true}
	model := x.embedder.Model()
	// Keyset pages through the candidates; each step is one bulk read plus
	// IndexPages' bulk calls, so the loop is bounded by the page count / 100.
	for {
		ids, err := x.queries.ListKbPagesNeedingEmbedding(ctx, db.ListKbPagesNeedingEmbeddingParams{
			AfterID: after, Model: model, RowLimit: backfillPageBatch,
		})
		if err != nil {
			return errors.Wrapf(err, "list pages needing embedding model=%s", model)
		}
		if len(ids) == 0 {
			return nil
		}

		if err := x.IndexPages(ctx, ids); err != nil {
			return err
		}
		after = ids[len(ids)-1]
	}
}

// embedTarget is one block whose vector is missing or stale.
type embedTarget struct {
	pageID, baseID, workspaceID pgtype.UUID
	blockID, hash, text         string
}

// IndexPages brings the vectors of the given pages up to date: blocks whose
// text hash or model changed are re-embedded in batches of at most
// the embedder's batch size, vectors of removed blocks and deleted pages are
// dropped. Unchanged blocks cost no embedding call.
func (x *EmbeddingIndexer) IndexPages(ctx context.Context, pageIDs []pgtype.UUID) error {
	if !x.Enabled() || len(pageIDs) == 0 {
		return nil
	}
	model := x.embedder.Model()

	pages, err := x.queries.ListKbPagesForEmbedding(ctx, pageIDs)
	if err != nil {
		return errors.Wrapf(err, "load pages for embedding pages=%d", len(pageIDs))
	}
	existing, err := x.queries.ListKbBlockEmbeddingHashes(ctx, pageIDs)
	if err != nil {
		return errors.Wrapf(err, "load embedding hashes pages=%d", len(pageIDs))
	}

	targets, stale, live, err := planEmbedding(pages, existing, model)
	if err != nil {
		return err
	}

	if len(stale) > 0 {
		params := db.DeleteKbBlockEmbeddingsParams{PageIds: make([]pgtype.UUID, len(stale)), BlockIds: make([]string, len(stale))}
		for i, row := range stale {
			params.PageIds[i] = row.PageID
			params.BlockIds[i] = row.BlockID
		}
		if err := x.queries.DeleteKbBlockEmbeddings(ctx, params); err != nil {
			return errors.Wrapf(err, "delete stale embeddings rows=%d", len(stale))
		}
	}

	// The upstream takes at most BatchSize inputs per call, so the targets go
	// out in chunks: one bulk embedding call and one bulk upsert per chunk.
	batch := max(x.embedder.BatchSize(), embedding.MinBatchSize)
	for start := 0; start < len(targets); start += batch {
		chunk := targets[start:min(start+batch, len(targets))]
		if err := x.embedChunk(ctx, model, chunk); err != nil {
			return err
		}
	}

	if len(live) > 0 {
		if err := x.queries.TouchKbBlockEmbeddings(ctx, live); err != nil {
			return errors.Wrapf(err, "touch embeddings pages=%d", len(live))
		}
	}

	return nil
}

func (x *EmbeddingIndexer) embedChunk(ctx context.Context, model string, chunk []embedTarget) error {
	inputs := make([]string, len(chunk))
	for i, target := range chunk {
		inputs[i] = target.text
	}
	vectors, err := x.embedder.Embed(ctx, inputs)
	if err != nil {
		return errors.Wrapf(err, "embed blocks model=%s blocks=%d", model, len(chunk))
	}

	params := db.UpsertKbBlockEmbeddingsParams{
		Model:            model,
		PageIds:          make([]pgtype.UUID, len(chunk)),
		BlockIds:         make([]string, len(chunk)),
		KnowledgeBaseIds: make([]pgtype.UUID, len(chunk)),
		WorkspaceIds:     make([]pgtype.UUID, len(chunk)),
		ContentHashes:    make([]string, len(chunk)),
		Embeddings:       make([]string, len(chunk)),
	}
	for i, target := range chunk {
		params.PageIds[i] = target.pageID
		params.BlockIds[i] = target.blockID
		params.KnowledgeBaseIds[i] = target.baseID
		params.WorkspaceIds[i] = target.workspaceID
		params.ContentHashes[i] = target.hash
		params.Embeddings[i] = VectorText(vectors[i])
	}
	if err := x.queries.UpsertKbBlockEmbeddings(ctx, params); err != nil {
		return errors.Wrapf(err, "upsert embeddings model=%s blocks=%d", model, len(chunk))
	}

	return nil
}

// planEmbedding compares the pages' blocks with their stored vectors: it
// returns the blocks to embed, the stored rows to drop, and the live pages.
func planEmbedding(pages []db.ListKbPagesForEmbeddingRow, existing []db.ListKbBlockEmbeddingHashesRow, model string) ([]embedTarget, []db.ListKbBlockEmbeddingHashesRow, []pgtype.UUID, error) {
	stored := make(map[blockKey]db.ListKbBlockEmbeddingHashesRow, len(existing))
	for _, row := range existing {
		stored[blockKey{util.UUIDToString(row.PageID), row.BlockID}] = row
	}

	keep := map[blockKey]bool{}
	targets := make([]embedTarget, 0)
	live := make([]pgtype.UUID, 0, len(pages))
	for _, page := range pages {
		if page.DeletedAt.Valid {
			continue
		}
		blocks, err := ParseBlocks(page.Blocks)
		if err != nil {
			return nil, nil, nil, errors.Wrapf(err, "page_id=%s", util.UUIDToString(page.ID))
		}
		live = append(live, page.ID)

		pageID := util.UUIDToString(page.ID)
		for _, block := range blocks {
			text := EmbeddingInput(block.Content)
			if text == "" {
				continue
			}
			key := blockKey{pageID, block.ID}
			keep[key] = true

			hash := ContentHash(text)
			if row, ok := stored[key]; ok && row.ContentHash == hash && row.Model == model {
				continue
			}
			targets = append(targets, embedTarget{
				pageID: page.ID, baseID: page.KnowledgeBaseID, workspaceID: page.WorkspaceID,
				blockID: block.ID, hash: hash, text: text,
			})
		}
	}

	stale := make([]db.ListKbBlockEmbeddingHashesRow, 0)
	for _, row := range existing {
		if !keep[blockKey{util.UUIDToString(row.PageID), row.BlockID}] {
			stale = append(stale, row)
		}
	}

	return targets, stale, live, nil
}

// EmbeddingInput is the text embedded for a block: its plain text, capped at
// embedInputRunes. Empty for a block without text.
func EmbeddingInput(markdown string) string {
	text := strings.TrimSpace(PlainText(markdown))
	if runes := []rune(text); len(runes) > embedInputRunes {
		text = string(runes[:embedInputRunes])
	}

	return text
}

// ContentHash is the sha256 of a block's embedding input; an unchanged hash
// means the stored vector is still valid.
func ContentHash(text string) string {
	sum := sha256.Sum256([]byte(text))

	return hex.EncodeToString(sum[:])
}

// VectorText formats a vector in pgvector's text form, "[1,2.5,-3]".
func VectorText(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'g', -1, 32))
	}
	b.WriteByte(']')

	return b.String()
}

// backoff doubles a delay from minRetryDelay up to maxRetryDelay.
type backoff struct{ next time.Duration }

func newBackoff() *backoff { return &backoff{next: minRetryDelay} }

func (b *backoff) reset() { b.next = minRetryDelay }

// wait sleeps for the current delay and doubles it; false when ctx ended.
func (b *backoff) wait(ctx context.Context) bool {
	timer := time.NewTimer(b.next)
	defer timer.Stop()
	b.next = min(b.next*2, maxRetryDelay)

	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
