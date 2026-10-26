package handler

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/logger"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// kbExportBatchSize is how many page bodies the export reads per query.
const kbExportBatchSize = 100

// kbExportFirstID is below every page id, the start of the export keyset.
var kbExportFirstID = pgtype.UUID{Valid: true}

// zipBundle writes an export into a zip archive, stamping every entry with
// the export time.
type zipBundle struct {
	zip *zip.Writer
	at  time.Time
}

func (z zipBundle) Create(name string) (io.Writer, error) {
	return z.zip.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: z.at})
}

// ExportKb streams a knowledge base as an OKF bundle zip (spec 7.12). The
// archive is written straight to the response: page bodies are read in
// batches and raw files are copied from storage one at a time, so nothing
// holds the whole bundle in memory.
func (h *Handler) ExportKb(w http.ResponseWriter, r *http.Request) {
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	export, raws, err := h.prepareKbExport(r.Context(), base)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, base.Slug+".zip"))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	// The status is sent: a failure from here on can only cut the archive
	// short, which the client sees as a broken download.
	archive := zip.NewWriter(w)
	if err := h.writeKbExport(r.Context(), archive, base, export, raws); err != nil {
		slog.Error("knowledge base export failed", append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", err))...)
		return
	}
	if err := archive.Close(); err != nil {
		slog.Error("knowledge base export failed", append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", errors.WithStack(err)))...)
	}
}

// prepareKbExport loads what lays the bundle out: the page tree, the blocks
// links point at and the raw files.
func (h *Handler) prepareKbExport(ctx context.Context, base db.KbBase) (*kb.Export, []db.ListKbRawsRow, error) {
	treeRows, err := h.Queries.ListKbExportTree(ctx, base.ID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list export tree knowledge_base_id=%s", uuidToString(base.ID))
	}
	nodes := make([]kb.ExportNode, len(treeRows))
	for i, row := range treeRows {
		nodes[i] = kb.ExportNode{
			ID:          uuidToString(row.ID),
			ParentID:    uuidToString(row.ParentID),
			Slug:        row.Slug,
			Position:    row.Position,
			Title:       row.Title,
			Description: row.Description,
		}
	}

	linkedRows, err := h.Queries.ListKbLinkedBlocks(ctx, base.ID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list linked blocks knowledge_base_id=%s", uuidToString(base.ID))
	}
	linked := make([]kb.LinkedBlock, len(linkedRows))
	for i, row := range linkedRows {
		linked[i] = kb.LinkedBlock{PageID: uuidToString(row.ToPageID), BlockID: row.ToBlockID, Content: row.Content}
	}

	raws, err := h.Queries.ListKbRaws(ctx, db.ListKbRawsParams{KnowledgeBaseID: base.ID})
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list raw files knowledge_base_id=%s", uuidToString(base.ID))
	}

	meta := kb.ExportMeta{Slug: base.Slug, Name: base.Name, Description: base.Description, Purpose: base.Purpose, Schema: base.Schema}

	return kb.NewExport(meta, nodes, linked), raws, nil
}

func (h *Handler) writeKbExport(ctx context.Context, archive *zip.Writer, base db.KbBase, export *kb.Export, raws []db.ListKbRawsRow) error {
	bundle := zipBundle{zip: archive, at: time.Now()}
	if err := export.WriteFrame(bundle); err != nil {
		return err
	}

	// Page bodies in keyset batches, one claims query per batch.
	after := kbExportFirstID
	for {
		pages, err := h.Queries.ListKbLivePagesAfter(ctx, db.ListKbLivePagesAfterParams{KnowledgeBaseID: base.ID, AfterID: after, RowLimit: kbExportBatchSize})
		if err != nil {
			return errors.Wrapf(err, "list export pages knowledge_base_id=%s", uuidToString(base.ID))
		}
		if len(pages) == 0 {
			break
		}
		if err := h.writeKbExportPages(ctx, bundle, base, export, pages); err != nil {
			return err
		}
		if len(pages) < kbExportBatchSize {
			break
		}
		after = pages[len(pages)-1].ID
	}

	// Object storage has no multi-object read; each raw file is streamed into
	// its zip entry in turn so only one is open at a time.
	for _, raw := range raws {
		if err := h.copyKbRawIntoExport(ctx, bundle, export, raw); err != nil {
			return err
		}
	}

	return nil
}

func (h *Handler) writeKbExportPages(ctx context.Context, bundle zipBundle, base db.KbBase, export *kb.Export, pages []db.KbPage) error {
	ids := make([]pgtype.UUID, len(pages))
	for i, page := range pages {
		ids[i] = page.ID
	}
	claimRows, err := h.Queries.ListKbClaimsByPages(ctx, db.ListKbClaimsByPagesParams{KnowledgeBaseID: base.ID, PageIds: ids})
	if err != nil {
		return errors.Wrapf(err, "list export claims knowledge_base_id=%s", uuidToString(base.ID))
	}
	claims := make(map[string][]kb.Claim, len(pages))
	for _, row := range claimRows {
		var evidence []kb.Evidence
		if err := json.Unmarshal(row.Evidence, &evidence); err != nil {
			return errors.Wrapf(err, "decode claim evidence claim_id=%s", uuidToString(row.ID))
		}
		pageID := uuidToString(row.PageID)
		claims[pageID] = append(claims[pageID], kb.Claim{
			Key:       row.Key,
			BlockID:   row.BlockID,
			Text:      row.Text,
			Evidence:  evidence,
			CheckedAt: timestampToString(row.CheckedAt),
		})
	}

	for _, page := range pages {
		blocks, err := kb.ParseBlocks(page.Blocks)
		if err != nil {
			return errors.Wrapf(err, "decode page blocks page_id=%s", uuidToString(page.ID))
		}
		frontmatter := map[string]any{}
		if len(page.Frontmatter) > 0 {
			if err := json.Unmarshal(page.Frontmatter, &frontmatter); err != nil {
				return errors.Wrapf(err, "decode page header page_id=%s", uuidToString(page.ID))
			}
		}

		pageID := uuidToString(page.ID)
		if err := export.WritePage(bundle, kb.ExportPage{ID: pageID, Frontmatter: frontmatter, Blocks: blocks, Claims: claims[pageID]}); err != nil {
			return err
		}
	}

	return nil
}

func (h *Handler) copyKbRawIntoExport(ctx context.Context, bundle zipBundle, export *kb.Export, raw db.ListKbRawsRow) error {
	if h.Storage == nil {
		return nil
	}

	reader, err := h.Storage.GetReader(ctx, raw.StorageKey)
	if err != nil {
		// A lost object leaves its file out rather than cutting the archive
		// short; pages still link to where it would be.
		slog.Warn("knowledge base export skipped a raw file", "raw_id", uuidToString(raw.ID), "error", err)
		return nil
	}
	defer func() { _ = reader.Close() }()

	entry, err := bundle.Create(export.RawPath(raw.Kind, raw.Name))
	if err != nil {
		return errors.Wrapf(err, "create export entry raw_id=%s", uuidToString(raw.ID))
	}
	if _, err := io.Copy(entry, reader); err != nil {
		return errors.Wrapf(err, "copy raw file id=%s", uuidToString(raw.ID))
	}

	return nil
}
