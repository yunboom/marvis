package kb

import (
	"strings"

	"github.com/pkg/errors"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// Fetch scopes (GET /api/kb/pages/{ref}/fetch?scope=).
const (
	// ScopeFull reads the whole page.
	ScopeFull = "full"
	// ScopeOutline reads only heading blocks.
	ScopeOutline = "outline"
	// ScopeSection reads one heading and everything under it.
	ScopeSection = "section"
	// ScopeKeyword reads the blocks containing a keyword.
	ScopeKeyword = "keyword"
	// ScopeRange reads a run of blocks between two block ids.
	ScopeRange = "range"
)

// Fetch detail levels (?detail=).
const (
	// DetailSimple returns the selected blocks as one Markdown text.
	DetailSimple = "simple"
	// DetailWithIDs returns the blocks with their ids.
	DetailWithIDs = "with-ids"
)

// MaxFetchBlocks caps how many blocks one fetch returns.
const MaxFetchBlocks = 200

// keywordSeparator splits several keywords in one parameter.
const keywordSeparator = "|"

// ErrInvalidFetch is a fetch request whose parameters do not fit the scope.
var ErrInvalidFetch = errors.New("invalid fetch parameters")

// FetchScope describes which blocks of a page to read.
type FetchScope struct {
	Scope         string
	StartBlockID  string
	EndBlockID    string
	Keyword       string
	ContextBefore int
	ContextAfter  int
	// MaxDepth limits outline headings to this level; 0 means all levels.
	MaxDepth int
}

// HeadingLevel returns the level (1-6) of a heading block, or 0 when the
// block is not a heading.
func HeadingLevel(content string) int {
	source := []byte(content)
	doc := markdownParser.Parse(text.NewReader(source))
	heading, ok := doc.FirstChild().(*ast.Heading)
	if !ok || doc.ChildCount() != 1 {
		return 0
	}

	return heading.Level
}

// SelectBlocks picks the blocks a fetch scope asks for, in page order, at
// most MaxFetchBlocks of them. truncated reports that the cap cut the result.
func SelectBlocks(blocks []Block, s FetchScope) (selected []Block, truncated bool, err error) {
	if s.ContextBefore < 0 || s.ContextAfter < 0 || s.MaxDepth < 0 {
		return nil, false, errors.Wrap(ErrInvalidFetch, "context and max_depth must not be negative")
	}

	var keep []bool
	switch s.Scope {
	case "", ScopeFull:
		keep = rangeMask(len(blocks), 0, len(blocks)-1)
	case ScopeOutline:
		keep = make([]bool, len(blocks))
		for i, block := range blocks {
			level := HeadingLevel(block.Content)
			keep[i] = level > 0 && (s.MaxDepth == 0 || level <= s.MaxDepth)
		}
	case ScopeSection:
		keep, err = sectionMask(blocks, s.StartBlockID)
	case ScopeKeyword:
		keep, err = keywordMask(blocks, s.Keyword)
	case ScopeRange:
		keep, err = blockRangeMask(blocks, s.StartBlockID, s.EndBlockID)
	default:
		return nil, false, errors.Wrapf(ErrInvalidFetch, "unknown scope %q", s.Scope)
	}
	if err != nil {
		return nil, false, err
	}

	if s.Scope == ScopeSection || s.Scope == ScopeKeyword || s.Scope == ScopeRange {
		keep = widenMask(keep, s.ContextBefore, s.ContextAfter)
	}

	selected = make([]Block, 0)
	for i, block := range blocks {
		if !keep[i] {
			continue
		}
		if len(selected) == MaxFetchBlocks {
			return selected, true, nil
		}
		selected = append(selected, block)
	}

	return selected, false, nil
}

func rangeMask(n, from, to int) []bool {
	mask := make([]bool, n)
	for i := from; i <= to && i < n; i++ {
		if i >= 0 {
			mask[i] = true
		}
	}

	return mask
}

// sectionMask keeps a heading block and the blocks after it up to the next
// heading of the same or a higher level.
func sectionMask(blocks []Block, startID string) ([]bool, error) {
	if startID == "" {
		return nil, errors.Wrap(ErrInvalidFetch, "section needs start_block_id")
	}
	start := blockIndex(blocks, startID)
	if start < 0 {
		return nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", startID)
	}
	level := HeadingLevel(blocks[start].Content)
	if level == 0 {
		return nil, errors.Wrapf(ErrInvalidFetch, "block %s is not a heading", startID)
	}

	end := len(blocks) - 1
	for i := start + 1; i < len(blocks); i++ {
		if l := HeadingLevel(blocks[i].Content); l > 0 && l <= level {
			end = i - 1
			break
		}
	}

	return rangeMask(len(blocks), start, end), nil
}

func keywordMask(blocks []Block, keyword string) ([]bool, error) {
	words := make([]string, 0)
	for _, w := range strings.Split(keyword, keywordSeparator) {
		if w = strings.ToLower(strings.TrimSpace(w)); w != "" {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return nil, errors.Wrap(ErrInvalidFetch, "keyword scope needs a keyword")
	}

	mask := make([]bool, len(blocks))
	for i, block := range blocks {
		content := strings.ToLower(block.Content)
		for _, w := range words {
			if strings.Contains(content, w) {
				mask[i] = true
				break
			}
		}
	}

	return mask, nil
}

func blockRangeMask(blocks []Block, startID, endID string) ([]bool, error) {
	if startID == "" {
		return nil, errors.Wrap(ErrInvalidFetch, "range needs start_block_id")
	}
	start := blockIndex(blocks, startID)
	if start < 0 {
		return nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", startID)
	}

	end := len(blocks) - 1
	if endID != "" {
		end = blockIndex(blocks, endID)
		if end < 0 {
			return nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", endID)
		}
		if end < start {
			return nil, errors.Wrap(ErrInvalidFetch, "end_block_id comes before start_block_id")
		}
	}

	return rangeMask(len(blocks), start, end), nil
}

// widenMask also keeps before blocks ahead of and after blocks behind every
// kept run.
func widenMask(mask []bool, before, after int) []bool {
	out := make([]bool, len(mask))
	for i, kept := range mask {
		if !kept {
			continue
		}
		for j := i - before; j <= i+after; j++ {
			if j >= 0 && j < len(mask) {
				out[j] = true
			}
		}
	}

	return out
}
