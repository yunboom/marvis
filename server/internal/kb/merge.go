package kb

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/pkg/errors"
)

// Conflict kinds recorded in kb_draft_page.conflicts.
const (
	// ConflictBlock is a block both sides changed, or one side deleted while
	// the other changed it; its content holds conflict markers.
	ConflictBlock = "block"
	// ConflictMeta is a header key both sides set to different values; the
	// draft value is kept and the mainline value recorded.
	ConflictMeta = "meta"
	// ConflictMove is a placement both sides changed differently, or a slug
	// that clashes with a sibling; the draft placement is kept.
	ConflictMove = "move"
	// ConflictPage is a page one side deleted while the other changed it;
	// the changed page is kept.
	ConflictPage = "page"
)

// Conflict is one unresolved difference between the draft and the mainline
// after kb draft sync.
type Conflict struct {
	Kind    string `json:"kind"`
	BlockID string `json:"block_id,omitempty"`
	Key     string `json:"key,omitempty"`
	// MainValue is the mainline value of a conflicted header key.
	MainValue any `json:"main_value,omitempty"`
	// MainLines and DraftLines are the conflicted block's line range on each
	// side ("15-16"), empty on a side that deleted it.
	MainLines  string `json:"main_lines,omitempty"`
	DraftLines string `json:"draft_lines,omitempty"`
}

// ParseConflicts decodes kb_draft_page.conflicts.
func ParseConflicts(raw []byte) ([]Conflict, error) {
	if len(raw) == 0 {
		return []Conflict{}, nil
	}

	var conflicts []Conflict
	if err := json.Unmarshal(raw, &conflicts); err != nil {
		return nil, errors.Wrap(err, "decode conflicts")
	}
	if conflicts == nil {
		conflicts = []Conflict{}
	}

	return conflicts, nil
}

// PageVersion is one side of a three-way page merge: the common base, the
// mainline or the draft.
type PageVersion struct {
	ParentID    string
	Position    string
	Slug        string
	Frontmatter map[string]any
	Blocks      []Block
	Claims      []Claim
	Deleted     bool
}

// MergeResult is the merged page and the conflicts left in it.
type MergeResult struct {
	Page      PageVersion
	Conflicts []Conflict
}

// MergePage merges the mainline's changes since base into the draft, page by
// page as in spec 6.3: blocks by id, header keys, claims by key and the
// placement fields each merge three ways. Conflicted blocks get git-style
// markers (mainline first); for header keys and placement the draft value
// is kept and the conflict recorded.
func MergePage(base, main, draft PageVersion) MergeResult {
	switch {
	case main.Deleted && draft.Deleted:
		return MergeResult{Page: draft, Conflicts: []Conflict{}}
	case main.Deleted:
		if samePage(base, draft) {
			return MergeResult{Page: main, Conflicts: []Conflict{}}
		}
		restored := draft
		restored.Deleted = false

		return MergeResult{Page: restored, Conflicts: []Conflict{{Kind: ConflictPage}}}
	case draft.Deleted:
		if samePage(base, main) {
			return MergeResult{Page: draft, Conflicts: []Conflict{}}
		}
		restored := main
		restored.Deleted = false

		return MergeResult{Page: restored, Conflicts: []Conflict{{Kind: ConflictPage}}}
	}

	blocks, conflicts := mergeBlocks(base.Blocks, main.Blocks, draft.Blocks)
	header, metaConflicts := mergeHeader(base.Frontmatter, main.Frontmatter, draft.Frontmatter)
	conflicts = append(conflicts, metaConflicts...)

	merged := PageVersion{
		ParentID:    draft.ParentID,
		Position:    draft.Position,
		Slug:        draft.Slug,
		Frontmatter: header,
		Blocks:      blocks,
		Claims:      mergeClaims(base.Claims, main.Claims, draft.Claims, blocks),
	}
	if moved, conflict := mergePlacement(base, main, draft, &merged); moved {
		conflicts = append(conflicts, conflict)
	}

	return MergeResult{Page: merged, Conflicts: conflicts}
}

func samePage(a, b PageVersion) bool {
	return a.ParentID == b.ParentID && a.Position == b.Position && a.Slug == b.Slug &&
		jsonEqual(a.Frontmatter, b.Frontmatter) && reflect.DeepEqual(a.Blocks, b.Blocks) &&
		jsonEqual(a.Claims, b.Claims)
}

// mergeBlocks merges block lists by id. The result follows the draft order;
// blocks only the mainline has go after their mainline predecessor, so when
// both sides insert at the same place the mainline's blocks come first.
func mergeBlocks(base, main, draft []Block) ([]Block, []Conflict) {
	baseByID := blocksByID(base)
	mainByID := blocksByID(main)
	draftByID := blocksByID(draft)
	mainLines := BlockLineRanges(main)
	draftLines := BlockLineRanges(draft)

	content := make(map[string]string)
	conflicts := make([]Conflict, 0)
	conflict := func(id, mainSide, draftSide string) {
		content[id] = ConflictContent(mainSide, draftSide)
		conflicts = append(conflicts, Conflict{
			Kind:       ConflictBlock,
			BlockID:    id,
			MainLines:  mainLines[id],
			DraftLines: draftLines[id],
		})
	}

	ids := make([]string, 0, len(base)+len(main)+len(draft))
	seen := make(map[string]struct{})
	for _, list := range [][]Block{draft, main, base} {
		for _, block := range list {
			if _, dup := seen[block.ID]; !dup {
				seen[block.ID] = struct{}{}
				ids = append(ids, block.ID)
			}
		}
	}

	for _, id := range ids {
		b, inBase := baseByID[id]
		m, inMain := mainByID[id]
		d, inDraft := draftByID[id]

		switch {
		case inMain && inDraft:
			switch {
			case m == d || (inBase && m == b):
				content[id] = d
			case inBase && d == b:
				content[id] = m
			default:
				conflict(id, m, d)
			}
		case inBase && inDraft:
			if d != b {
				conflict(id, "", d)
			}
		case inBase && inMain:
			if m != b {
				conflict(id, m, "")
			}
		case inMain:
			content[id] = m
		case inDraft:
			content[id] = d
		}
	}

	order := make([]string, 0, len(content))
	placed := make(map[string]bool, len(content))
	for _, block := range draft {
		if _, ok := content[block.ID]; ok {
			order = append(order, block.ID)
			placed[block.ID] = true
		}
	}
	for i, block := range main {
		if _, ok := content[block.ID]; !ok || placed[block.ID] {
			continue
		}
		at := 0
		for j := i - 1; j >= 0; j-- {
			if placed[main[j].ID] {
				at = indexOf(order, main[j].ID) + 1
				break
			}
		}
		order = append(order[:at], append([]string{block.ID}, order[at:]...)...)
		placed[block.ID] = true
	}

	merged := make([]Block, len(order))
	for i, id := range order {
		merged[i] = Block{ID: id, Kind: BlockKindText, Content: content[id]}
	}

	return merged, conflicts
}

func mergeHeader(base, main, draft map[string]any) (map[string]any, []Conflict) {
	keys := make([]string, 0)
	seen := make(map[string]struct{})
	for _, header := range []map[string]any{draft, main, base} {
		for key := range header {
			if _, dup := seen[key]; !dup {
				seen[key] = struct{}{}
				keys = append(keys, key)
			}
		}
	}
	sort.Strings(keys)

	out := make(map[string]any, len(keys))
	conflicts := make([]Conflict, 0)
	for _, key := range keys {
		b, inBase := base[key]
		m, inMain := main[key]
		d, inDraft := draft[key]

		if key == MetaGenerated {
			if inMain {
				out[key] = m
			}
			continue
		}

		mainSame := inMain == inBase && jsonEqual(m, b)
		draftSame := inDraft == inBase && jsonEqual(d, b)
		agree := inMain == inDraft && jsonEqual(m, d)

		switch {
		case mainSame || agree:
			if inDraft {
				out[key] = d
			}
		case draftSame:
			if inMain {
				out[key] = m
			}
		default:
			if inDraft {
				out[key] = d
			}
			conflicts = append(conflicts, Conflict{Kind: ConflictMeta, Key: key, MainValue: m})
		}
	}

	return out, conflicts
}

// mergeClaims merges claims by key; when both sides changed a claim the
// draft wins, since claims are rewritten whole by kb claims set. Claims on
// blocks the merged page no longer has are dropped.
func mergeClaims(base, main, draft []Claim, blocks []Block) []Claim {
	baseByKey := claimsByKey(base)
	mainByKey := claimsByKey(main)
	draftByKey := claimsByKey(draft)
	live := blocksByID(blocks)

	out := make([]Claim, 0, len(draft)+len(main))
	add := func(c Claim) {
		if _, ok := live[c.BlockID]; ok {
			out = append(out, c)
		}
	}

	for _, c := range draft {
		b, inBase := baseByKey[c.Key]
		m, inMain := mainByKey[c.Key]
		draftSame := inBase && jsonEqual(c, b)
		switch {
		case draftSame && !inMain:
			// The mainline removed it and the draft did not touch it.
		case draftSame:
			add(m)
		default:
			add(c)
		}
	}
	for _, c := range main {
		if _, inDraft := draftByKey[c.Key]; inDraft {
			continue
		}
		b, inBase := baseByKey[c.Key]
		if inBase && jsonEqual(c, b) {
			continue
		}
		if inBase {
			// The draft removed it; the draft wins.
			continue
		}
		add(c)
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })

	return out
}

// mergePlacement merges parent, position and slug field by field. A field
// both sides changed differently keeps the draft value and reports a move
// conflict.
func mergePlacement(base, main, draft PageVersion, merged *PageVersion) (bool, Conflict) {
	conflicted := false
	pick := func(b, m, d string) string {
		switch {
		case m == b || m == d:
			return d
		case d == b:
			return m
		default:
			conflicted = true
			return d
		}
	}

	merged.ParentID = pick(base.ParentID, main.ParentID, draft.ParentID)
	merged.Position = pick(base.Position, main.Position, draft.Position)
	merged.Slug = pick(base.Slug, main.Slug, draft.Slug)

	return conflicted, Conflict{Kind: ConflictMove}
}

// BlockLineRanges maps each block to its line range ("15-16") in the page
// rendered by JoinBlocks.
func BlockLineRanges(blocks []Block) map[string]string {
	ranges := make(map[string]string, len(blocks))
	line := 1
	for _, block := range blocks {
		n := strings.Count(block.Content, "\n") + 1
		ranges[block.ID] = fmt.Sprintf("%d-%d", line, line+n-1)
		line += n + 1
	}

	return ranges
}

// BlockOfLines lists, for each line of the page rendered by JoinBlocks, the
// id of the block it belongs to ("" for the blank separator lines).
func BlockOfLines(blocks []Block) []string {
	out := make([]string, 0)
	for i, block := range blocks {
		if i > 0 {
			out = append(out, "")
		}
		for range strings.Count(block.Content, "\n") + 1 {
			out = append(out, block.ID)
		}
	}

	return out
}

func blocksByID(blocks []Block) map[string]string {
	out := make(map[string]string, len(blocks))
	for _, block := range blocks {
		out[block.ID] = block.Content
	}

	return out
}

func claimsByKey(claims []Claim) map[string]Claim {
	out := make(map[string]Claim, len(claims))
	for _, c := range claims {
		out[c.Key] = c
	}

	return out
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}

	return -1
}

// jsonEqual compares two values by their JSON form, so numbers decoded from
// different sources still compare equal.
func jsonEqual(a, b any) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)

	return errA == nil && errB == nil && string(ja) == string(jb)
}
