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

// emptyClaims is the claims snapshot of a page without claims.
var emptyClaims = []byte("[]")

// NewPage describes a page written straight to the mainline: the quickstart
// page at creation, and later merged pages that did not exist before.
type NewPage struct {
	WorkspaceID     string
	KnowledgeBaseID string
	// ParentID is empty for a top-level page.
	ParentID    string
	Position    string
	Slug        string
	Reserved    string
	Type        string
	Title       string
	Description string
	// Frontmatter is the full page header, unknown keys included.
	Frontmatter map[string]any
	// Markdown is the page body; it is split into blocks with new ids.
	Markdown   string
	StaleAfter *time.Time
	// MergeRequestID is empty for the initial revision written at creation.
	MergeRequestID string
}

// CreatePage writes a new page to the mainline: its first revision, the page
// row with blocks and search text, and its outgoing links. Run it with
// queries bound to the caller's transaction so the write is atomic.
func CreatePage(ctx context.Context, q *db.Queries, in NewPage) (db.KbPage, error) {
	baseID, err := util.ParseUUID(in.KnowledgeBaseID)
	if err != nil {
		return db.KbPage{}, errors.Wrapf(err, "knowledge_base_id=%q", in.KnowledgeBaseID)
	}
	workspaceID, err := util.ParseUUID(in.WorkspaceID)
	if err != nil {
		return db.KbPage{}, errors.Wrapf(err, "workspace_id=%q", in.WorkspaceID)
	}
	parentID, err := optionalUUID(in.ParentID)
	if err != nil {
		return db.KbPage{}, errors.Wrapf(err, "parent_id=%q", in.ParentID)
	}

	tree, ids, err := loadWriteContext(ctx, q, baseID)
	if err != nil {
		return db.KbPage{}, err
	}

	pageID := uuid.New()
	revisionID := uuid.New()
	blocks, err := NewBlocks(in.Markdown, ids)
	if err != nil {
		return db.KbPage{}, err
	}
	tree.Add(TreeNode{ID: pageID.String(), ParentID: in.ParentID, Slug: in.Slug})
	blocks, links := ResolveLinks(blocks, tree)

	blocksJSON, err := json.Marshal(blocks)
	if err != nil {
		return db.KbPage{}, errors.WithStack(err)
	}
	frontmatter := in.Frontmatter
	if frontmatter == nil {
		frontmatter = map[string]any{}
	}
	frontmatterJSON, err := json.Marshal(frontmatter)
	if err != nil {
		return db.KbPage{}, errors.WithStack(err)
	}
	mergeRequestID, err := optionalUUID(in.MergeRequestID)
	if err != nil {
		return db.KbPage{}, errors.Wrapf(err, "merge_request_id=%q", in.MergeRequestID)
	}

	if _, err := q.CreateKbPageRevision(ctx, db.CreateKbPageRevisionParams{
		ID:              pgtype.UUID{Bytes: revisionID, Valid: true},
		WorkspaceID:     workspaceID,
		KnowledgeBaseID: baseID,
		PageID:          pgtype.UUID{Bytes: pageID, Valid: true},
		MergeRequestID:  mergeRequestID,
		ParentID:        parentID,
		Position:        in.Position,
		Slug:            in.Slug,
		Frontmatter:     frontmatterJSON,
		Blocks:          blocksJSON,
		Claims:          emptyClaims,
	}); err != nil {
		return db.KbPage{}, errors.Wrapf(err, "create revision page_id=%s", pageID)
	}

	page, err := q.CreateKbPage(ctx, db.CreateKbPageParams{
		ID:              pgtype.UUID{Bytes: pageID, Valid: true},
		WorkspaceID:     workspaceID,
		KnowledgeBaseID: baseID,
		ParentID:        parentID,
		Position:        in.Position,
		Slug:            in.Slug,
		Reserved:        in.Reserved,
		Type:            in.Type,
		Title:           in.Title,
		Description:     in.Description,
		Frontmatter:     frontmatterJSON,
		Blocks:          blocksJSON,
		SearchText:      SearchText(in.Title, blocks),
		HeadRevisionID:  pgtype.UUID{Bytes: revisionID, Valid: true},
		StaleAfter:      optionalTimestamp(in.StaleAfter),
	})
	if err != nil {
		return db.KbPage{}, errors.Wrapf(err, "create page slug=%q", in.Slug)
	}

	if err := ReplacePageLinks(ctx, q, workspaceID, baseID, page.ID, links); err != nil {
		return db.KbPage{}, err
	}

	return page, nil
}

// ReplacePageLinks rewrites the mainline kb_link rows of one page.
func ReplacePageLinks(ctx context.Context, q *db.Queries, workspaceID, baseID, pageID pgtype.UUID, links []Link) error {
	if err := q.DeleteKbLinksFromPage(ctx, db.DeleteKbLinksFromPageParams{
		KnowledgeBaseID: baseID,
		FromPageID:      pageID,
	}); err != nil {
		return errors.Wrapf(err, "delete links page_id=%s", util.UUIDToString(pageID))
	}

	if len(links) == 0 {
		return nil
	}

	params := db.CreateKbLinksParams{
		WorkspaceID:     workspaceID,
		KnowledgeBaseID: baseID,
		FromPageID:      pageID,
		FromBlockIds:    make([]string, len(links)),
		ToPageIds:       make([]pgtype.UUID, len(links)),
		ToBlockIds:      make([]string, len(links)),
		ToPaths:         make([]string, len(links)),
	}
	for i, link := range links {
		toPageID, err := optionalUUID(link.ToPageID)
		if err != nil {
			return errors.Wrapf(err, "to_page_id=%q", link.ToPageID)
		}
		params.FromBlockIds[i] = link.FromBlockID
		params.ToPageIds[i] = toPageID
		params.ToBlockIds[i] = link.ToBlockID
		params.ToPaths[i] = link.ToPath
	}

	if err := q.CreateKbLinks(ctx, params); err != nil {
		return errors.Wrapf(err, "create links page_id=%s", util.UUIDToString(pageID))
	}

	return nil
}

// loadWriteContext loads the page tree and the block ids in use, both needed
// before blocks can be allocated and links resolved.
func loadWriteContext(ctx context.Context, q *db.Queries, baseID pgtype.UUID) (*PageTree, *BlockIDAllocator, error) {
	rows, err := q.ListKbPageTree(ctx, baseID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list page tree knowledge_base_id=%s", util.UUIDToString(baseID))
	}
	nodes := make([]TreeNode, len(rows))
	for i, row := range rows {
		nodes[i] = TreeNode{ID: util.UUIDToString(row.ID), ParentID: uuidOrEmpty(row.ParentID), Slug: row.Slug}
	}

	usedIDs, err := q.ListKbPageBlockIDs(ctx, baseID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list block ids knowledge_base_id=%s", util.UUIDToString(baseID))
	}

	return NewPageTree(nodes), NewBlockIDAllocator(usedIDs), nil
}

func optionalUUID(s string) (pgtype.UUID, error) {
	if s == "" {
		return pgtype.UUID{}, nil
	}

	return util.ParseUUID(s)
}

func uuidOrEmpty(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}

	return util.UUIDToString(u)
}

func optionalTimestamp(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}

	return pgtype.Timestamptz{Time: *t, Valid: true}
}
