package kb

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// AnnotationAnchorLost reports whether an annotation lost its sentence: it
// still remembers a quote but no longer points at a block, so it reads as a
// note on the whole page (spec 7.6, design 5.7).
func AnnotationAnchorLost(a db.KbAnnotation) bool {
	return a.PageID.Valid && a.Quote != "" && a.BlockID == ""
}

// RelocateAnnotations moves the sentence annotations of rewritten pages to
// where their sentences are now. Call it in the transaction that writes the
// new mainline bodies, with every rewritten page and its new blocks; a nil
// block list (a deleted page) loses every anchor on that page. It returns
// the ids of the annotations whose anchor changed.
func RelocateAnnotations(ctx context.Context, q *db.Queries, baseID pgtype.UUID, pages map[pgtype.UUID][]Block) ([]pgtype.UUID, error) {
	if len(pages) == 0 {
		return nil, nil
	}

	pageIDs := make([]pgtype.UUID, 0, len(pages))
	for id := range pages {
		pageIDs = append(pageIDs, id)
	}

	rows, err := q.ListKbAnchoredAnnotations(ctx, db.ListKbAnchoredAnnotationsParams{
		KnowledgeBaseID: baseID,
		PageIds:         pageIDs,
		ExcludedStatus:  AnnotationStatusResolved,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list anchored annotations knowledge_base_id=%s", util.UUIDToString(baseID))
	}

	update := db.UpdateKbAnnotationAnchorsParams{KnowledgeBaseID: baseID}
	for _, row := range rows {
		old := Anchor{BlockID: row.BlockID, Quote: row.Quote, Prefix: row.Prefix, Suffix: row.Suffix}
		next, outcome := Relocate(old, pages[row.PageID])

		originalQuote := row.OriginalQuote
		if outcome == AnchorLost {
			// Falls back to the whole page; the quote stays for display.
			next = Anchor{Quote: old.Quote, Prefix: old.Prefix, Suffix: old.Suffix}
		}
		if next.Quote != old.Quote && originalQuote == "" {
			originalQuote = old.Quote
		}
		if next.Quote == originalQuote {
			originalQuote = ""
		}
		if next == old && originalQuote == row.OriginalQuote {
			continue
		}

		update.Ids = append(update.Ids, row.ID)
		update.BlockIds = append(update.BlockIds, next.BlockID)
		update.Quotes = append(update.Quotes, next.Quote)
		update.Prefixes = append(update.Prefixes, next.Prefix)
		update.Suffixes = append(update.Suffixes, next.Suffix)
		update.OriginalQuotes = append(update.OriginalQuotes, originalQuote)
	}
	if len(update.Ids) == 0 {
		return nil, nil
	}

	if err := q.UpdateKbAnnotationAnchors(ctx, update); err != nil {
		return nil, errors.Wrapf(err, "update annotation anchors knowledge_base_id=%s", util.UUIDToString(baseID))
	}

	return update.Ids, nil
}

// AttachAnnotations marks the pending annotations a merge request handles as
// processing (spec 7.6). Annotations that are not pending, or belong to
// another knowledge base, are skipped; it returns the ids it changed.
func AttachAnnotations(ctx context.Context, q *db.Queries, baseID, mergeRequestID pgtype.UUID, ids []pgtype.UUID) ([]pgtype.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	changed, err := q.AttachKbAnnotationsToMergeRequest(ctx, db.AttachKbAnnotationsToMergeRequestParams{
		ToStatus:        AnnotationStatusProcessing,
		MergeRequestID:  mergeRequestID,
		KnowledgeBaseID: baseID,
		Ids:             ids,
		FromStatus:      AnnotationStatusPending,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "attach annotations merge_request_id=%s", util.UUIDToString(mergeRequestID))
	}

	return changed, nil
}

// ResolveAnnotations marks a merged request's annotations resolved; they keep
// pointing at the merge request that resolved them.
func ResolveAnnotations(ctx context.Context, q *db.Queries, mergeRequestID pgtype.UUID) ([]pgtype.UUID, error) {
	return settleAnnotations(ctx, q, mergeRequestID, AnnotationStatusResolved, false)
}

// ReleaseAnnotations puts a closed request's annotations back to pending and
// detaches them from it.
func ReleaseAnnotations(ctx context.Context, q *db.Queries, mergeRequestID pgtype.UUID) ([]pgtype.UUID, error) {
	return settleAnnotations(ctx, q, mergeRequestID, AnnotationStatusPending, true)
}

func settleAnnotations(ctx context.Context, q *db.Queries, mergeRequestID pgtype.UUID, to string, clearMergeRequest bool) ([]pgtype.UUID, error) {
	changed, err := q.SettleKbAnnotationsOfMergeRequest(ctx, db.SettleKbAnnotationsOfMergeRequestParams{
		ToStatus:          to,
		ClearMergeRequest: clearMergeRequest,
		MergeRequestID:    mergeRequestID,
		FromStatus:        AnnotationStatusProcessing,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "settle annotations merge_request_id=%s status=%s", util.UUIDToString(mergeRequestID), to)
	}

	return changed, nil
}
