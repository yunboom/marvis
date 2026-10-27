package kb

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// dateLayout is the date-only form stale_after may be written in.
const dateLayout = "2006-01-02"

// MainlinePage is one page a merge writes to the mainline.
type MainlinePage struct {
	PageID pgtype.UUID
	// PrevRevisionID is the mainline head the page moves on from; invalid for
	// a page the merge creates.
	PrevRevisionID pgtype.UUID
	// Page is the merged page; Deleted removes it from the mainline.
	Page PageVersion
}

// MainlineWrite is the set of pages one merge request writes.
type MainlineWrite struct {
	WorkspaceID     pgtype.UUID
	KnowledgeBaseID pgtype.UUID
	MergeRequestID  pgtype.UUID
	Pages           []MainlinePage
	// Tree is the page tree after the merge; links are resolved against it.
	Tree *PageTree
}

// MainlineResult is what a mainline write produced.
type MainlineResult struct {
	// Revisions maps each written page to its new head revision.
	Revisions map[pgtype.UUID]pgtype.UUID
	// Blocks holds each page's stored blocks, nil for a deleted page, which is
	// what annotation relocation runs on.
	Blocks map[pgtype.UUID][]Block
}

// WriteMainline writes merged pages to the mainline inside the caller's
// transaction (spec 6.3): one new revision per page, the page rows with
// their search text and stale_after, the pages' outgoing links and claims,
// and the links other pages wrote to a path that now has a page. Every step
// is one batched statement. After commit the caller passes the page ids to
// EmbeddingIndexer.Enqueue.
func WriteMainline(ctx context.Context, q *db.Queries, in MainlineWrite) (MainlineResult, error) {
	result := MainlineResult{
		Revisions: make(map[pgtype.UUID]pgtype.UUID, len(in.Pages)),
		Blocks:    make(map[pgtype.UUID][]Block, len(in.Pages)),
	}
	if len(in.Pages) == 0 {
		return result, nil
	}

	revisions := db.CreateKbPageRevisionsParams{
		WorkspaceID:     in.WorkspaceID,
		KnowledgeBaseID: in.KnowledgeBaseID,
		MergeRequestID:  in.MergeRequestID,
	}
	pages := db.UpsertKbPagesParams{WorkspaceID: in.WorkspaceID, KnowledgeBaseID: in.KnowledgeBaseID}
	links := db.CreateKbLinksOfPagesParams{WorkspaceID: in.WorkspaceID, KnowledgeBaseID: in.KnowledgeBaseID}
	claims := db.CreateKbClaimsParams{WorkspaceID: in.WorkspaceID, KnowledgeBaseID: in.KnowledgeBaseID}
	dangling := db.ResolveKbDanglingLinksParams{KnowledgeBaseID: in.KnowledgeBaseID}
	pageIDs := make([]pgtype.UUID, 0, len(in.Pages))

	for _, p := range in.Pages {
		pageID := util.UUIDToString(p.PageID)
		revisionID := pgtype.UUID{Bytes: uuid.New(), Valid: true}
		result.Revisions[p.PageID] = revisionID
		pageIDs = append(pageIDs, p.PageID)

		blocks := p.Page.Blocks
		var pageLinks []Link
		if !p.Page.Deleted {
			blocks, pageLinks = ResolveLinks(blocks, in.Tree)
			result.Blocks[p.PageID] = blocks
		} else {
			result.Blocks[p.PageID] = nil
		}

		header := p.Page.Frontmatter
		if header == nil {
			header = map[string]any{}
		}
		headerJSON, err := json.Marshal(header)
		if err != nil {
			return MainlineResult{}, errors.Wrapf(err, "encode frontmatter page_id=%s", pageID)
		}
		blocksJSON, err := json.Marshal(blocks)
		if err != nil {
			return MainlineResult{}, errors.Wrapf(err, "encode blocks page_id=%s", pageID)
		}
		pageClaims := p.Page.Claims
		if pageClaims == nil || p.Page.Deleted {
			pageClaims = []Claim{}
		}
		claimsJSON, err := json.Marshal(pageClaims)
		if err != nil {
			return MainlineResult{}, errors.Wrapf(err, "encode claims page_id=%s", pageID)
		}
		parentID, err := optionalUUID(p.Page.ParentID)
		if err != nil {
			return MainlineResult{}, errors.Wrapf(err, "parent_id=%q", p.Page.ParentID)
		}
		_, meta, err := ParseFrontmatter(headerJSON)
		if err != nil {
			return MainlineResult{}, errors.Wrapf(err, "page_id=%s", pageID)
		}

		revisions.Ids = append(revisions.Ids, revisionID)
		revisions.PageIds = append(revisions.PageIds, p.PageID)
		revisions.PrevRevisionIds = append(revisions.PrevRevisionIds, p.PrevRevisionID)
		revisions.ParentIds = append(revisions.ParentIds, parentID)
		revisions.Positions = append(revisions.Positions, p.Page.Position)
		revisions.Slugs = append(revisions.Slugs, p.Page.Slug)
		revisions.Frontmatters = append(revisions.Frontmatters, headerJSON)
		revisions.Blocks = append(revisions.Blocks, blocksJSON)
		revisions.Claims = append(revisions.Claims, claimsJSON)
		revisions.Deleted = append(revisions.Deleted, p.Page.Deleted)

		pages.Ids = append(pages.Ids, p.PageID)
		pages.ParentIds = append(pages.ParentIds, parentID)
		pages.Positions = append(pages.Positions, p.Page.Position)
		pages.Slugs = append(pages.Slugs, p.Page.Slug)
		pages.Types = append(pages.Types, meta.Type)
		pages.Titles = append(pages.Titles, meta.Title)
		pages.Descriptions = append(pages.Descriptions, meta.Description)
		pages.Frontmatters = append(pages.Frontmatters, headerJSON)
		pages.Blocks = append(pages.Blocks, blocksJSON)
		pages.SearchTexts = append(pages.SearchTexts, SearchText(meta.Title, blocks))
		pages.HeadRevisionIds = append(pages.HeadRevisionIds, revisionID)
		pages.StaleAfters = append(pages.StaleAfters, parseStaleAfter(meta.StaleAfter))
		pages.Deleted = append(pages.Deleted, p.Page.Deleted)

		if p.Page.Deleted {
			continue
		}
		for _, link := range pageLinks {
			toPageID, err := optionalUUID(link.ToPageID)
			if err != nil {
				return MainlineResult{}, errors.Wrapf(err, "to_page_id=%q", link.ToPageID)
			}
			links.FromPageIds = append(links.FromPageIds, p.PageID)
			links.FromBlockIds = append(links.FromBlockIds, link.FromBlockID)
			links.ToPageIds = append(links.ToPageIds, toPageID)
			links.ToBlockIds = append(links.ToBlockIds, link.ToBlockID)
			links.ToPaths = append(links.ToPaths, link.ToPath)
		}
		for _, c := range pageClaims {
			evidence, err := json.Marshal(c.Evidence)
			if err != nil {
				return MainlineResult{}, errors.Wrapf(err, "encode evidence page_id=%s key=%s", pageID, c.Key)
			}
			claims.PageIds = append(claims.PageIds, p.PageID)
			claims.BlockIds = append(claims.BlockIds, c.BlockID)
			claims.Keys = append(claims.Keys, c.Key)
			claims.Texts = append(claims.Texts, c.Text)
			claims.Evidence = append(claims.Evidence, evidence)
			claims.CheckedAts = append(claims.CheckedAts, claimCheckedAt(c.CheckedAt))
		}
		if path, ok := in.Tree.PathByPageID(pageID); ok {
			dangling.Paths = append(dangling.Paths, path)
			dangling.PageIds = append(dangling.PageIds, p.PageID)
		}
	}

	if err := q.CreateKbPageRevisions(ctx, revisions); err != nil {
		return MainlineResult{}, errors.Wrapf(err, "create revisions merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
	}
	if err := q.UpsertKbPages(ctx, pages); err != nil {
		return MainlineResult{}, errors.Wrapf(err, "write pages merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
	}

	if err := q.DeleteKbLinksFromPages(ctx, db.DeleteKbLinksFromPagesParams{KnowledgeBaseID: in.KnowledgeBaseID, PageIds: pageIDs}); err != nil {
		return MainlineResult{}, errors.Wrapf(err, "delete links merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
	}
	if len(links.FromPageIds) > 0 {
		if err := q.CreateKbLinksOfPages(ctx, links); err != nil {
			return MainlineResult{}, errors.Wrapf(err, "create links merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
		}
	}
	if len(dangling.Paths) > 0 {
		if err := q.ResolveKbDanglingLinks(ctx, dangling); err != nil {
			return MainlineResult{}, errors.Wrapf(err, "resolve dangling links merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
		}
	}

	if err := q.DeleteKbClaimsOfPages(ctx, db.DeleteKbClaimsOfPagesParams{KnowledgeBaseID: in.KnowledgeBaseID, PageIds: pageIDs}); err != nil {
		return MainlineResult{}, errors.Wrapf(err, "delete claims merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
	}
	if len(claims.PageIds) > 0 {
		if err := q.CreateKbClaims(ctx, claims); err != nil {
			return MainlineResult{}, errors.Wrapf(err, "create claims merge_request_id=%s", util.UUIDToString(in.MergeRequestID))
		}
	}

	return result, nil
}

// parseStaleAfter reads the stale_after header (RFC3339, or a date); an
// empty or unreadable value means the page never goes stale.
func parseStaleAfter(raw string) pgtype.Timestamptz {
	if raw == "" {
		return pgtype.Timestamptz{}
	}
	for _, layout := range []string{time.RFC3339Nano, dateLayout} {
		if t, err := time.Parse(layout, raw); err == nil {
			return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
		}
	}

	return pgtype.Timestamptz{}
}

// claimCheckedAt reads a claim's checked_at, falling back to now for claims
// written before it was recorded.
func claimCheckedAt(raw string) pgtype.Timestamptz {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return pgtype.Timestamptz{Time: t, Valid: true}
	}

	return pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
}

// Generated is the generated header a merge writes on every page it
// changes (spec 4.4): who wrote the change and when it was merged.
func Generated(by string, at time.Time) map[string]any {
	return map[string]any{"by": by, "at": at.UTC().Format(time.RFC3339)}
}
