package kb

import (
	"strings"

	"github.com/pkg/errors"
)

// Page ops accepted by POST /api/kb/drafts/{id}/pages/{ref}/ops.
const (
	// OpBlockReplace replaces one block; the first resulting block keeps its id.
	OpBlockReplace = "block_replace"
	// OpBlockInsertAfter inserts Markdown after a block, or first with "start".
	OpBlockInsertAfter = "block_insert_after"
	// OpBlockDelete removes one block.
	OpBlockDelete = "block_delete"
	// OpBlockMoveAfter moves one block after another, or first with "start".
	OpBlockMoveAfter = "block_move_after"
	// OpStrReplace replaces text that occurs exactly once on the page.
	OpStrReplace = "str_replace"
	// OpAppend adds Markdown at the end of the page.
	OpAppend = "append"
	// OpSetMeta changes page header fields.
	OpSetMeta = "set_meta"
	// OpMove moves or renames the page.
	OpMove = "move"
	// OpDelete deletes the page.
	OpDelete = "delete"
)

// BlockStart is the anchor that inserts or moves a block to the top.
const BlockStart = "start"

// Frontmatter keys the system maintains and writers may not set.
const (
	// MetaSources is generated from claims.
	MetaSources = "sources"
	// MetaGenerated is written at merge time.
	MetaGenerated = "generated"
	// MetaType is the OKF type.
	MetaType = "type"
	// MetaTitle is the page title.
	MetaTitle = "title"
	// MetaDescription is the one-line description.
	MetaDescription = "description"
	// MetaStaleAfter is when the page needs re-checking.
	MetaStaleAfter = "stale_after"
)

// protectedMetaKeys are header keys only Marvis writes.
var protectedMetaKeys = map[string]bool{MetaSources: true, MetaGenerated: true}

// ErrStrReplaceMatch is returned when str_replace text matches zero or
// several times on the page.
var ErrStrReplaceMatch = errors.New("text must occur exactly once on the page")

// ErrProtectedMeta is returned when set_meta touches sources or generated.
var ErrProtectedMeta = errors.New("sources and generated are maintained by Marvis")

// ErrConflictMarkers is returned when written content still holds conflict
// marker lines from kb draft sync.
var ErrConflictMarkers = errors.New("content still contains conflict markers")

// Conflict marker lines written into a conflicted block by kb draft sync,
// git style: the mainline side first, then the draft side.
const (
	ConflictMarkerMain   = "<<<<<<< 主线"
	ConflictMarkerSplit  = "======="
	ConflictMarkerDraft  = ">>>>>>> 草稿"
	conflictMarkerOpen   = "<<<<<<<"
	conflictMarkerClosed = ">>>>>>>"
)

// HasConflictMarkers reports whether Markdown still holds an opening or
// closing conflict marker line. A bare "=======" alone is a setext heading
// underline, so it does not count.
func HasConflictMarkers(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimRight(line, " \t\r")
		if strings.HasPrefix(trimmed, conflictMarkerOpen) || strings.HasPrefix(trimmed, conflictMarkerClosed) {
			return true
		}
	}

	return false
}

// ConflictContent renders both sides of a conflicted block with git markers.
// An empty side means that side deleted the block.
func ConflictContent(mainline, draft string) string {
	parts := []string{ConflictMarkerMain}
	if mainline != "" {
		parts = append(parts, mainline)
	}
	parts = append(parts, ConflictMarkerSplit)
	if draft != "" {
		parts = append(parts, draft)
	}
	parts = append(parts, ConflictMarkerDraft)

	return strings.Join(parts, "\n")
}

func blockIndex(blocks []Block, blockID string) int {
	for i, block := range blocks {
		if block.ID == blockID {
			return i
		}
	}

	return -1
}

// anchorIndex resolves an insert or move anchor: -1 for "start", the block's
// index otherwise.
func anchorIndex(blocks []Block, anchor string) (int, error) {
	if anchor == BlockStart {
		return -1, nil
	}

	i := blockIndex(blocks, anchor)
	if i < 0 {
		return 0, errors.Wrapf(ErrBlockNotFound, "block_id=%s", anchor)
	}

	return i, nil
}

// InsertBlocksAfter splits Markdown into blocks with new ids and inserts them
// after the anchor block ("start" inserts at the top). It returns the updated
// blocks and the new ids.
func InsertBlocksAfter(blocks []Block, anchor, markdown string, ids *BlockIDAllocator) ([]Block, []string, error) {
	at, err := anchorIndex(blocks, anchor)
	if err != nil {
		return nil, nil, err
	}

	inserted, err := NewBlocks(markdown, ids)
	if err != nil {
		return nil, nil, err
	}
	if len(inserted) == 0 {
		return nil, nil, errors.Wrapf(ErrEmptyBlockContent, "after=%s", anchor)
	}

	out := make([]Block, 0, len(blocks)+len(inserted))
	out = append(out, blocks[:at+1]...)
	out = append(out, inserted...)
	out = append(out, blocks[at+1:]...)

	return out, blockIDs(inserted), nil
}

// AppendBlocks adds Markdown as new blocks at the end of the page.
func AppendBlocks(blocks []Block, markdown string, ids *BlockIDAllocator) ([]Block, []string, error) {
	appended, err := NewBlocks(markdown, ids)
	if err != nil {
		return nil, nil, err
	}
	if len(appended) == 0 {
		return nil, nil, errors.WithStack(ErrEmptyBlockContent)
	}

	out := make([]Block, 0, len(blocks)+len(appended))
	out = append(out, blocks...)
	out = append(out, appended...)

	return out, blockIDs(appended), nil
}

// DeleteBlock removes one block.
func DeleteBlock(blocks []Block, blockID string) ([]Block, error) {
	i := blockIndex(blocks, blockID)
	if i < 0 {
		return nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", blockID)
	}

	out := make([]Block, 0, len(blocks)-1)
	out = append(out, blocks[:i]...)
	out = append(out, blocks[i+1:]...)

	return out, nil
}

// MoveBlockAfter moves a block after the anchor block ("start" moves it to
// the top). Moving a block after itself leaves the order unchanged.
func MoveBlockAfter(blocks []Block, blockID, anchor string) ([]Block, error) {
	i := blockIndex(blocks, blockID)
	if i < 0 {
		return nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", blockID)
	}
	if anchor == blockID {
		return blocks, nil
	}

	moved := blocks[i]
	rest := make([]Block, 0, len(blocks)-1)
	rest = append(rest, blocks[:i]...)
	rest = append(rest, blocks[i+1:]...)

	at, err := anchorIndex(rest, anchor)
	if err != nil {
		return nil, err
	}

	out := make([]Block, 0, len(blocks))
	out = append(out, rest[:at+1]...)
	out = append(out, moved)
	out = append(out, rest[at+1:]...)

	return out, nil
}

// StrReplace replaces text that occurs exactly once on the page. The block
// holding it is re-split like block_replace, so it keeps its id. It returns
// the updated blocks, the id of the changed block and the new ids.
func StrReplace(blocks []Block, find, replace string, ids *BlockIDAllocator) ([]Block, string, []string, error) {
	if find == "" {
		return nil, "", nil, errors.WithStack(ErrStrReplaceMatch)
	}

	matches := 0
	target := -1
	for i, block := range blocks {
		n := strings.Count(block.Content, find)
		if n > 0 {
			target = i
		}
		matches += n
	}
	if matches != 1 {
		return nil, "", nil, errors.Wrapf(ErrStrReplaceMatch, "matches=%d", matches)
	}

	blockID := blocks[target].ID
	content := strings.Replace(blocks[target].Content, find, replace, 1)
	if strings.TrimSpace(content) == "" {
		out, err := DeleteBlock(blocks, blockID)

		return out, blockID, nil, err
	}

	out, newIDs, err := ReplaceBlock(blocks, blockID, content, ids)

	return out, blockID, newIDs, err
}

// SetMeta applies header field changes. A nil value removes the key (a
// removed required key is reported by the format check). sources and
// generated are refused.
func SetMeta(header map[string]any, fields map[string]any) (map[string]any, error) {
	out := make(map[string]any, len(header)+len(fields))
	for k, v := range header {
		out[k] = v
	}

	for key, value := range fields {
		if protectedMetaKeys[key] {
			return nil, errors.Wrapf(ErrProtectedMeta, "key=%s", key)
		}
		if value == nil {
			delete(out, key)
			continue
		}
		out[key] = value
	}

	return out, nil
}

func blockIDs(blocks []Block) []string {
	out := make([]string, len(blocks))
	for i, block := range blocks {
		out[i] = block.ID
	}

	return out
}
