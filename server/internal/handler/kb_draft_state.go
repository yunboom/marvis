package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// kbDraftPage is one page as a draft has it: its draft copy, or the mainline
// page about to be copied into the draft by its first write.
type kbDraftPage struct {
	pageID string
	// op is the draft op; empty until the page is first written.
	op           string
	baseRevision pgtype.UUID
	parentID     string
	position     string
	slug         string
	header       map[string]any
	blocks       []kb.Block
	claims       []kb.Claim
	conflicts    []kb.Conflict
	// version is the draft version of the page's last write.
	version int64
	inDraft bool
	// mainHead is the mainline head revision when the page is on the mainline.
	mainHead pgtype.UUID
}

// kbDraftPageFromRow decodes a kb_draft_page row.
func kbDraftPageFromRow(row db.KbDraftPage) (kbDraftPage, error) {
	pageID := uuidToString(row.PageID)

	header, _, err := kb.ParseFrontmatter(row.Frontmatter)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", pageID)
	}
	blocks, err := kb.ParseBlocks(row.Blocks)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", pageID)
	}
	claims, err := kb.ParseClaims(row.Claims)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", pageID)
	}
	conflicts, err := kb.ParseConflicts(row.Conflicts)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", pageID)
	}

	return kbDraftPage{
		pageID:       pageID,
		op:           row.Op,
		baseRevision: row.BaseRevisionID,
		parentID:     uuidOrEmpty(row.ParentID),
		position:     row.Position,
		slug:         row.Slug,
		header:       header,
		blocks:       blocks,
		claims:       claims,
		conflicts:    conflicts,
		version:      row.Version,
		inDraft:      true,
	}, nil
}

// loadKbDraftPage reads a page through a draft inside the write transaction:
// the draft copy when there is one, else the live mainline page.
func loadKbDraftPage(ctx context.Context, q *db.Queries, base db.KbBase, draft db.KbDraft, pageID pgtype.UUID) (kbDraftPage, error) {
	var mainline *db.KbPage
	page, err := q.GetKbPage(ctx, db.GetKbPageParams{KnowledgeBaseID: base.ID, ID: pageID})
	switch {
	case err == nil:
		mainline = &page
	case !isNotFound(err):
		return kbDraftPage{}, errors.Wrapf(err, "load page page_id=%s", uuidToString(pageID))
	}

	row, err := q.GetKbDraftPage(ctx, db.GetKbDraftPageParams{DraftID: draft.ID, PageID: pageID})
	if err == nil {
		state, err := kbDraftPageFromRow(row)
		if err != nil {
			return kbDraftPage{}, err
		}
		if mainline != nil {
			state.mainHead = mainline.HeadRevisionID
		}
		if state.op == kb.DraftOpDelete {
			return kbDraftPage{}, kbFail(http.StatusNotFound, kbCodePageNotFound, "the page is deleted in this draft")
		}

		return state, nil
	}
	if !isNotFound(err) {
		return kbDraftPage{}, errors.Wrapf(err, "load draft page page_id=%s", uuidToString(pageID))
	}

	if mainline == nil || mainline.DeletedAt.Valid {
		return kbDraftPage{}, kbFail(http.StatusNotFound, kbCodePageNotFound, "page not found")
	}

	revision, err := q.GetKbPageRevision(ctx, db.GetKbPageRevisionParams{PageID: mainline.ID, ID: mainline.HeadRevisionID})
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "load head revision page_id=%s", uuidToString(pageID))
	}
	header, _, err := kb.ParseFrontmatter(mainline.Frontmatter)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", uuidToString(pageID))
	}
	blocks, err := kb.ParseBlocks(mainline.Blocks)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", uuidToString(pageID))
	}
	claims, err := kb.ParseClaims(revision.Claims)
	if err != nil {
		return kbDraftPage{}, errors.Wrapf(err, "page_id=%s", uuidToString(pageID))
	}

	return kbDraftPage{
		pageID:       uuidToString(pageID),
		baseRevision: mainline.HeadRevisionID,
		parentID:     uuidOrEmpty(mainline.ParentID),
		position:     mainline.Position,
		slug:         mainline.Slug,
		header:       header,
		blocks:       blocks,
		claims:       claims,
		conflicts:    []kb.Conflict{},
		mainHead:     mainline.HeadRevisionID,
	}, nil
}

// kbDraftVersion renders the version a draft page reports: d<draft version>.
func kbDraftVersion(version int64) string {
	return fmt.Sprintf("%s%d", draftVersionPrefix, version)
}

// checkKbPageVersion compares the version a write carries with the page: a
// draft page accepts d<n> when the page was not written after draft version
// n; a page not yet in the draft accepts its mainline head revision id.
func checkKbPageVersion(page kbDraftPage, draft db.KbDraft, version string) error {
	stale := kbFail(http.StatusConflict, kbCodeStaleVersion, "the page changed after you read it; fetch it again")
	if version == "" {
		return kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "version is required")
	}

	if !page.inDraft {
		if version != uuidToString(page.mainHead) {
			return stale
		}

		return nil
	}

	n, err := strconv.ParseInt(strings.TrimPrefix(version, draftVersionPrefix), 10, 64)
	if err != nil || !strings.HasPrefix(version, draftVersionPrefix) || n < page.version || n > draft.Version {
		return stale
	}

	return nil
}

// saveKbDraftPage writes a page into the draft and bumps the draft version.
// It returns the new draft version.
func saveKbDraftPage(ctx context.Context, q *db.Queries, draft db.KbDraft, page *kbDraftPage) (int64, error) {
	return saveKbDraftPages(ctx, q, draft, []*kbDraftPage{page})
}

// saveKbDraftPages writes pages into the draft under a single version bump
// and one batched upsert. It returns the new draft version.
func saveKbDraftPages(ctx context.Context, q *db.Queries, draft db.KbDraft, pages []*kbDraftPage) (int64, error) {
	bumped, err := q.BumpKbDraftVersion(ctx, draft.ID)
	if err != nil {
		return 0, errors.Wrapf(err, "bump draft version draft_id=%s", uuidToString(draft.ID))
	}

	params := db.UpsertKbDraftPagesParams{DraftID: draft.ID, Version: bumped.Version}
	for _, page := range pages {
		page.version = bumped.Version
		page.inDraft = true

		header, err := json.Marshal(page.header)
		if err != nil {
			return 0, errors.WithStack(err)
		}
		blocks, err := json.Marshal(page.blocks)
		if err != nil {
			return 0, errors.WithStack(err)
		}
		claims, err := json.Marshal(page.claims)
		if err != nil {
			return 0, errors.WithStack(err)
		}
		conflicts, err := json.Marshal(page.conflicts)
		if err != nil {
			return 0, errors.WithStack(err)
		}
		parentID, err := optionalPgUUID(page.parentID)
		if err != nil {
			return 0, err
		}

		params.PageIds = append(params.PageIds, parseUUID(page.pageID))
		params.Ops = append(params.Ops, page.op)
		params.BaseRevisionIds = append(params.BaseRevisionIds, page.baseRevision)
		params.ParentIds = append(params.ParentIds, parentID)
		params.Positions = append(params.Positions, page.position)
		params.Slugs = append(params.Slugs, page.slug)
		params.Frontmatters = append(params.Frontmatters, header)
		params.Blocks = append(params.Blocks, blocks)
		params.Claims = append(params.Claims, claims)
		params.Conflicts = append(params.Conflicts, conflicts)
	}

	if err := q.UpsertKbDraftPages(ctx, params); err != nil {
		return 0, errors.Wrapf(err, "save draft pages draft_id=%s pages=%d", uuidToString(draft.ID), len(pages))
	}

	return bumped.Version, nil
}

func optionalPgUUID(s string) (pgtype.UUID, error) {
	if s == "" {
		return pgtype.UUID{}, nil
	}
	id, err := util.ParseUUID(s)

	return id, errors.Wrapf(err, "uuid=%q", s)
}

// kbOverlay is the page tree as a draft has it: mainline pages with the
// draft's new, moved and renamed pages laid over them, without the pages
// the draft deletes.
type kbOverlay struct {
	tree  *kb.PageTree
	nodes map[string]kb.TreeNode
	// rows are the draft's page rows, decoded.
	rows map[string]kbDraftPage
	// order lists the draft's pages by page id.
	order []string
}

// loadKbOverlay builds the draft's tree from the mainline tree and the
// draft's rows, reading through q so a transaction sees its own writes.
func loadKbOverlay(ctx context.Context, q *db.Queries, baseID, draftID pgtype.UUID) (kbOverlay, error) {
	treeRows, err := q.ListKbPageTree(ctx, baseID)
	if err != nil {
		return kbOverlay{}, errors.Wrapf(err, "list page tree knowledge_base_id=%s", uuidToString(baseID))
	}
	draftRows, err := q.ListKbDraftPageRows(ctx, draftID)
	if err != nil {
		return kbOverlay{}, errors.Wrapf(err, "list draft pages draft_id=%s", uuidToString(draftID))
	}

	nodes := make(map[string]kb.TreeNode, len(treeRows)+len(draftRows))
	for _, row := range treeRows {
		id := uuidToString(row.ID)
		nodes[id] = kb.TreeNode{ID: id, ParentID: uuidOrEmpty(row.ParentID), Slug: row.Slug, Title: row.Title, Position: row.Position}
	}

	overlay := kbOverlay{nodes: nodes, rows: make(map[string]kbDraftPage, len(draftRows)), order: make([]string, 0, len(draftRows))}
	for _, row := range draftRows {
		page, err := kbDraftPageFromRow(row)
		if err != nil {
			return kbOverlay{}, err
		}
		overlay.rows[page.pageID] = page
		overlay.order = append(overlay.order, page.pageID)

		if page.op == kb.DraftOpDelete {
			delete(nodes, page.pageID)
			continue
		}
		title, _ := page.header[kb.MetaTitle].(string)
		nodes[page.pageID] = kb.TreeNode{ID: page.pageID, ParentID: page.parentID, Slug: page.slug, Title: title, Position: page.position}
	}

	overlay.rebuild()

	return overlay, nil
}

func (o *kbOverlay) rebuild() {
	list := make([]kb.TreeNode, 0, len(o.nodes))
	for _, node := range o.nodes {
		list = append(list, node)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	o.tree = kb.NewPageTree(list)
}

// place records where a page now sits, for checks later in the same write.
func (o *kbOverlay) place(page kbDraftPage) {
	if page.op == kb.DraftOpDelete {
		delete(o.nodes, page.pageID)
	} else {
		title, _ := page.header[kb.MetaTitle].(string)
		o.nodes[page.pageID] = kb.TreeNode{ID: page.pageID, ParentID: page.parentID, Slug: page.slug, Title: title, Position: page.position}
	}
	if _, known := o.rows[page.pageID]; !known {
		o.order = append(o.order, page.pageID)
	}
	o.rows[page.pageID] = page
	o.rebuild()
}

// siblings lists the pages under a parent ("" for the top level) in sort
// order, leaving out one page.
func (o *kbOverlay) siblings(parentID, except string) []kb.TreeNode {
	out := make([]kb.TreeNode, 0)
	for _, node := range o.nodes {
		if node.ParentID == parentID && node.ID != except {
			out = append(out, node)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Position != out[j].Position {
			return out[i].Position < out[j].Position
		}

		return out[i].ID < out[j].ID
	})

	return out
}

// slugTaken reports whether a sibling other than the page uses the slug.
func (o *kbOverlay) slugTaken(parentID, slug, except string) bool {
	for _, node := range o.siblings(parentID, except) {
		if node.Slug == slug {
			return true
		}
	}

	return false
}

// positionAfter picks a sort key right after the given sibling, or after
// the last sibling when afterID is empty.
func (o *kbOverlay) positionAfter(parentID, afterID, except string) (string, error) {
	siblings := o.siblings(parentID, except)
	if afterID == "" {
		if len(siblings) == 0 {
			return kb.PositionBetween("", ""), nil
		}

		return kb.PositionBetween(siblings[len(siblings)-1].Position, ""), nil
	}

	for i, node := range siblings {
		if node.ID != afterID {
			continue
		}
		next := ""
		if i+1 < len(siblings) {
			next = siblings[i+1].Position
		}

		return kb.PositionBetween(node.Position, next), nil
	}

	return "", kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "after must be a page under the same parent")
}

// isDescendant reports whether page sits below ancestor in the tree.
func (o *kbOverlay) isDescendant(pageID, ancestor string) bool {
	for _, node := range o.tree.Ancestors(pageID) {
		if node.ID == ancestor {
			return true
		}
	}

	return false
}

// hasChildren reports whether live pages sit under the page.
func (o *kbOverlay) hasChildren(pageID string) bool {
	return len(o.siblings(pageID, "")) > 0
}

// resolveRef resolves a page reference inside the overlay: a page id, or a
// <kb slug>:/<path> of this knowledge base. "<kb>:/" is the top level and
// resolves to "" with root=true.
func (o *kbOverlay) resolveRef(base db.KbBase, ref string) (pageID string, root bool, err error) {
	parsed := kb.ParsePageRef(ref)
	if parsed.PageID != "" {
		if _, ok := o.nodes[parsed.PageID]; !ok {
			return "", false, kbFail(http.StatusNotFound, kbCodePageNotFound, fmt.Sprintf("page %s not found", ref))
		}

		return parsed.PageID, false, nil
	}

	if parsed.KbSlug != "" && parsed.KbSlug != base.Slug {
		return "", false, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "the page reference names another knowledge base")
	}
	if parsed.Path == "/" {
		return "", true, nil
	}
	id, ok := o.tree.PageIDByPath(parsed.Path)
	if !ok {
		return "", false, kbFail(http.StatusNotFound, kbCodePageNotFound, fmt.Sprintf("page %s not found", ref))
	}

	return id, false, nil
}

// lintKbDraftPages runs the format checks on the draft's live pages (only
// the listed ones when pageIDs is not empty).
func lintKbDraftPages(ctx context.Context, q *db.Queries, base db.KbBase, overlay kbOverlay, pageIDs []string) ([]lint.Finding, error) {
	targets := pageIDs
	if len(targets) == 0 {
		targets = overlay.order
	}

	draftIDs := make([]pgtype.UUID, 0, len(overlay.rows))
	for id := range overlay.rows {
		draftIDs = append(draftIDs, parseUUID(id))
	}
	targetIDs := make([]pgtype.UUID, 0, len(targets))
	for _, id := range targets {
		targetIDs = append(targetIDs, parseUUID(id))
	}

	inbound := make(map[string]int, len(targets))
	rows, err := q.CountKbInboundLinks(ctx, db.CountKbInboundLinksParams{
		KnowledgeBaseID: base.ID,
		PageIds:         targetIDs,
		ExcludeIds:      draftIDs,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "count inbound links knowledge_base_id=%s", uuidToString(base.ID))
	}
	for _, row := range rows {
		inbound[uuidToString(row.ToPageID)] = int(row.LinkCount)
	}

	linked := make(map[string][]string, len(overlay.rows))
	unresolved := make(map[string][]string, len(overlay.rows))
	for id, page := range overlay.rows {
		if page.op == kb.DraftOpDelete {
			continue
		}
		linked[id], unresolved[id] = kb.PageLinks(page.blocks, id, overlay.tree)
		for _, to := range linked[id] {
			inbound[to]++
		}
	}

	findings := make([]lint.Finding, 0)
	for _, id := range targets {
		page, ok := overlay.rows[id]
		if !ok || page.op == kb.DraftOpDelete {
			continue
		}
		path, _ := overlay.tree.PathByPageID(id)
		findings = append(findings, lint.Check(lint.Page{
			ID:              id,
			Path:            path,
			Frontmatter:     page.header,
			Blocks:          page.blocks,
			Claims:          page.claims,
			Conflicts:       page.conflicts,
			DuplicateSlug:   overlay.slugTaken(page.parentID, page.slug, id),
			UnresolvedLinks: unresolved[id],
			LinkedPages:     len(linked[id]) + len(unresolved[id]),
			Inbound:         inbound[id],
		})...)
	}

	return findings, nil
}

// kbSourcesHeader renders the page header sources list from claims.
func kbSourcesHeader(blocks []kb.Block, claims []kb.Claim) []map[string]any {
	sources := kb.SourcesFromClaims(blocks, claims)
	out := make([]map[string]any, len(sources))
	for i, s := range sources {
		out[i] = map[string]any{"id": s.ID, "resource": s.URI, "title": s.Title}
	}

	return out
}

// pageMention renders the [title](mention://kb_page/<id>) a reply pastes to
// show a page card.
func pageMention(title, pageID string) string {
	return "[" + mentionLabelEscaper.Replace(title) + "](mention://kb_page/" + pageID + ")"
}
