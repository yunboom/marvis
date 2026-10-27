package kb

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/pkg/errors"
)

// Draft page operations (kb_draft_page.op).
const (
	// DraftOpCreate is a page the draft adds.
	DraftOpCreate = "create"
	// DraftOpUpdate is a mainline page the draft edits.
	DraftOpUpdate = "update"
	// DraftOpMove is a mainline page the draft moves or renames.
	DraftOpMove = "move"
	// DraftOpDelete is a mainline page the draft deletes.
	DraftOpDelete = "delete"
)

// What a draft did to a page, as the tree and reading page report it.
const (
	// DraftChangeNone means the draft leaves the page alone, or no draft
	// was asked for.
	DraftChangeNone = ""
	// DraftChangeAdded is a page the draft creates.
	DraftChangeAdded = "added"
	// DraftChangeModified is a page the draft edits.
	DraftChangeModified = "modified"
	// DraftChangeMoved is a page the draft moves or renames.
	DraftChangeMoved = "moved"
	// DraftChangeDeleted is a page the draft deletes; it stays listed.
	DraftChangeDeleted = "deleted"
)

var draftChanges = map[string]string{
	DraftOpCreate: DraftChangeAdded,
	DraftOpUpdate: DraftChangeModified,
	DraftOpMove:   DraftChangeMoved,
	DraftOpDelete: DraftChangeDeleted,
}

// DraftChange maps a draft page op to the change the tree reports.
func DraftChange(op string) string {
	return draftChanges[op]
}

// Frontmatter is the part of a page header the reading surfaces need; the
// full header stays a JSON object.
type Frontmatter struct {
	Type        string
	Title       string
	Description string
	StaleAfter  string
}

// ParseFrontmatter decodes a stored page header into a generic object and
// the fields the tree and reading page use.
func ParseFrontmatter(raw []byte) (map[string]any, Frontmatter, error) {
	header := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &header); err != nil {
			return nil, Frontmatter{}, errors.Wrap(err, "decode frontmatter")
		}
	}
	if header == nil {
		header = map[string]any{}
	}

	text := func(key string) string {
		s, _ := header[key].(string)
		return s
	}

	return header, Frontmatter{
		Type:        text("type"),
		Title:       text("title"),
		Description: text("description"),
		StaleAfter:  text("stale_after"),
	}, nil
}

// LevelPage is one entry of a tree level in sort order.
type LevelPage struct {
	ID       string
	Position string
	// DraftChange is set for pages the requested draft touches.
	DraftChange string
}

// MergeLevel merges the mainline entries of one tree level (already past the
// cursor, without the pages the draft touches, at most limit+1 of them) with
// the draft's entries for the same level, and cuts one page of limit entries.
// hasMore reports whether entries remain after that page.
func MergeLevel(mainline, draft []LevelPage, cursor *PageCursor, limit int) ([]LevelPage, bool) {
	merged := make([]LevelPage, 0, len(mainline)+len(draft))
	merged = append(merged, mainline...)
	for _, page := range draft {
		if cursor != nil && !cursor.After(page.Position, page.ID) {
			continue
		}
		merged = append(merged, page)
	}

	sort.SliceStable(merged, func(i, j int) bool {
		if merged[i].Position != merged[j].Position {
			return merged[i].Position < merged[j].Position
		}

		return merged[i].ID < merged[j].ID
	})

	if len(merged) > limit {
		return merged[:limit], true
	}

	return merged, false
}

// DraftPlacement is where a draft puts a page, next to where the mainline
// has it.
type DraftPlacement struct {
	PageID string
	// ParentID is the parent in the draft; empty for the top level.
	ParentID string
	// MainParentID is the mainline parent; meaningful when OnMainline.
	MainParentID string
	OnMainline   bool
}

// ChildCounts adjusts mainline child counts of the listed pages for a draft:
// pages the draft moves away no longer count under their mainline parent,
// pages it creates or moves in count under their draft parent. Pages the
// draft deletes still count, because the tree keeps listing them.
func ChildCounts(pageIDs []string, mainline map[string]int64, placements []DraftPlacement) map[string]int64 {
	counts := make(map[string]int64, len(pageIDs))
	listed := make(map[string]struct{}, len(pageIDs))
	for _, id := range pageIDs {
		counts[id] = mainline[id]
		listed[id] = struct{}{}
	}

	for _, p := range placements {
		stays := p.OnMainline && p.MainParentID == p.ParentID
		if stays {
			continue
		}
		if _, ok := listed[p.MainParentID]; ok && p.OnMainline {
			counts[p.MainParentID]--
		}
		if _, ok := listed[p.ParentID]; ok {
			counts[p.ParentID]++
		}
	}

	return counts
}

// PageRef is a parsed page reference: a page id, or <kb slug>:<path>.
type PageRef struct {
	PageID string
	KbSlug string
	Path   string
}

// ParsePageRef parses "team:/payment/callback" or a bare page id. A bare
// path ("/payment") is accepted when the knowledge base is known from the
// request; KbSlug is then empty.
func ParsePageRef(ref string) PageRef {
	if slug, path, found := strings.Cut(ref, ":"); found && strings.HasPrefix(path, "/") {
		return PageRef{KbSlug: slug, Path: NormalizePagePath(path)}
	}
	if strings.HasPrefix(ref, "/") {
		return PageRef{Path: NormalizePagePath(ref)}
	}

	return PageRef{PageID: ref}
}

// pageRoutePrefix is the app route of the reading page, without the
// workspace slug: /kb/<kb slug>/p/<page id>. The app prefixes the current
// workspace to /kb/… links.
const pageRoutePrefix = "/kb/"

// PageRoute renders the app route of a page, with a block anchor when set.
func PageRoute(kbSlug, pageID, blockID string) string {
	route := pageRoutePrefix + kbSlug + "/p/" + pageID
	if blockID == "" {
		return route
	}

	return route + "#" + blockID
}

// RouteLinks rewrites stored kb:// links in blocks to app routes for the
// reading page. Unresolved path links (pages not written yet) stay as paths.
func RouteLinks(blocks []Block, kbSlug string) []Block {
	out := make([]Block, len(blocks))
	for i, block := range blocks {
		out[i] = block
		out[i].Content = RewriteLinkDestinations(block.Content, func(dest string) (string, bool) {
			target, ok := ParseLinkTarget(dest)
			if !ok || target.PageID == "" {
				return "", false
			}

			return PageRoute(kbSlug, target.PageID, target.BlockID), true
		})
	}

	return out
}

// ChangedBlockCount counts the blocks a draft adds, edits or removes
// compared with the mainline page.
func ChangedBlockCount(mainline, draft []Block) int {
	before := make(map[string]string, len(mainline))
	for _, block := range mainline {
		before[block.ID] = block.Content
	}

	changed := 0
	seen := make(map[string]struct{}, len(draft))
	for _, block := range draft {
		seen[block.ID] = struct{}{}
		if content, ok := before[block.ID]; !ok || content != block.Content {
			changed++
		}
	}
	for id := range before {
		if _, ok := seen[id]; !ok {
			changed++
		}
	}

	return changed
}
