package kb

import (
	"crypto/rand"
	"math/big"
	"sort"
	"strings"

	"github.com/pkg/errors"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// BlockKindText is the only block kind today: the block content is one
// Markdown fragment. The field exists so other kinds can be added without
// changing the stored shape.
const BlockKindText = "text"

// Block is one top-level Markdown structure of a page body: a heading, a
// paragraph, a whole list, a table, a code block or a block quote.
type Block struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

// ErrBlockNotFound is returned when a block id is not on the page.
var ErrBlockNotFound = errors.New("block not found")

// ErrEmptyBlockContent is returned when a write would leave no block behind;
// removing a block is a delete, not an empty replace.
var ErrEmptyBlockContent = errors.New("block content is empty")

// markdownParser is plain CommonMark. Tables are not a CommonMark block, so a
// table parses as one paragraph and still becomes one block.
var markdownParser = goldmark.New().Parser()

// SplitMarkdown cuts Markdown into its top-level blocks. Each block keeps its
// original source text (markers, fences and indentation included) with
// trailing blank lines removed. A standalone link reference definition
// becomes its own block.
func SplitMarkdown(src string) []string {
	source := []byte(src)
	doc := markdownParser.Parse(text.NewReader(source))

	starts := make([]int, 0, doc.ChildCount())
	for child := doc.FirstChild(); child != nil; child = child.NextSibling() {
		start := nodeStart(child)
		if start < 0 {
			continue
		}
		starts = append(starts, lineStart(source, start))
	}
	sort.Ints(starts)

	pieces := make([]string, 0, len(starts))
	for i, start := range starts {
		if i > 0 && start == starts[i-1] {
			continue
		}

		end := len(source)
		if i+1 < len(starts) {
			end = starts[i+1]
		}

		piece := strings.TrimRight(string(source[start:end]), " \t\r\n")
		if strings.TrimSpace(piece) == "" {
			continue
		}
		pieces = append(pieces, piece)
	}

	return pieces
}

// nodeStart returns the byte offset where a block node begins, or -1 when the
// node carries no position at all.
func nodeStart(n ast.Node) int {
	if pos := n.Pos(); pos >= 0 {
		return pos
	}

	if n.Type() == ast.TypeBlock && n.Lines().Len() > 0 {
		return n.Lines().At(0).Start
	}

	start := -1
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		if s := nodeStart(child); s >= 0 && (start < 0 || s < start) {
			start = s
		}
	}

	return start
}

// lineStart moves an offset back to the beginning of its line so indentation
// and block markers stay with the block.
func lineStart(source []byte, offset int) int {
	if offset > len(source) {
		offset = len(source)
	}
	for offset > 0 && source[offset-1] != '\n' {
		offset--
	}

	return offset
}

// blockIDAlphabet is the character set of the three random characters after
// the "b" prefix of a block id (for example "b7Kq").
const blockIDAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// blockIDPrefix starts every block id so it never looks like a number.
const blockIDPrefix = "b"

// blockIDRandomLength is the number of random characters after the prefix.
const blockIDRandomLength = 3

// maxBlockIDAttempts bounds the retries when a random id collides.
const maxBlockIDAttempts = 1000

// ErrBlockIDsExhausted means no unused block id was found; it only happens
// when a knowledge base holds a large share of the id space.
var ErrBlockIDsExhausted = errors.New("no unused block id available")

// BlockIDAllocator hands out 4-character block ids that are unique within one
// knowledge base. Seed it with every id already in use there.
type BlockIDAllocator struct {
	used map[string]struct{}
}

// NewBlockIDAllocator returns an allocator that avoids the given ids.
func NewBlockIDAllocator(used []string) *BlockIDAllocator {
	set := make(map[string]struct{}, len(used))
	for _, id := range used {
		set[id] = struct{}{}
	}

	return &BlockIDAllocator{used: set}
}

// Reserve marks an id as taken, for ids that are kept rather than allocated.
func (a *BlockIDAllocator) Reserve(id string) {
	a.used[id] = struct{}{}
}

// Next returns a fresh id and marks it as taken.
func (a *BlockIDAllocator) Next() (string, error) {
	alphabetSize := big.NewInt(int64(len(blockIDAlphabet)))

	for range maxBlockIDAttempts {
		var b strings.Builder
		b.WriteString(blockIDPrefix)
		for range blockIDRandomLength {
			n, err := rand.Int(rand.Reader, alphabetSize)
			if err != nil {
				return "", errors.WithStack(err)
			}
			b.WriteByte(blockIDAlphabet[n.Int64()])
		}

		id := b.String()
		if _, taken := a.used[id]; taken {
			continue
		}
		a.used[id] = struct{}{}

		return id, nil
	}

	return "", errors.WithStack(ErrBlockIDsExhausted)
}

// NewBlocks splits Markdown into blocks with freshly allocated ids.
func NewBlocks(markdown string, ids *BlockIDAllocator) ([]Block, error) {
	pieces := SplitMarkdown(markdown)
	blocks := make([]Block, 0, len(pieces))
	for _, piece := range pieces {
		id, err := ids.Next()
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, Block{ID: id, Kind: BlockKindText, Content: piece})
	}

	return blocks, nil
}

// ReplaceBlock replaces one block with new Markdown (block_replace). The first
// resulting block keeps the original id; when the Markdown splits into several
// blocks the rest get new ids and follow it in order. It returns the updated
// blocks and the ids that were newly allocated.
func ReplaceBlock(blocks []Block, blockID, markdown string, ids *BlockIDAllocator) ([]Block, []string, error) {
	index := -1
	for i, block := range blocks {
		if block.ID == blockID {
			index = i
			break
		}
	}
	if index < 0 {
		return nil, nil, errors.Wrapf(ErrBlockNotFound, "block_id=%s", blockID)
	}

	pieces := SplitMarkdown(markdown)
	if len(pieces) == 0 {
		return nil, nil, errors.Wrapf(ErrEmptyBlockContent, "block_id=%s", blockID)
	}

	replacement := make([]Block, 0, len(pieces))
	replacement = append(replacement, Block{ID: blockID, Kind: BlockKindText, Content: pieces[0]})

	newIDs := make([]string, 0, len(pieces)-1)
	for _, piece := range pieces[1:] {
		id, err := ids.Next()
		if err != nil {
			return nil, nil, err
		}
		newIDs = append(newIDs, id)
		replacement = append(replacement, Block{ID: id, Kind: BlockKindText, Content: piece})
	}

	out := make([]Block, 0, len(blocks)+len(replacement)-1)
	out = append(out, blocks[:index]...)
	out = append(out, replacement...)
	out = append(out, blocks[index+1:]...)

	return out, newIDs, nil
}

// JoinBlocks renders blocks back into one Markdown document.
func JoinBlocks(blocks []Block) string {
	parts := make([]string, len(blocks))
	for i, block := range blocks {
		parts[i] = block.Content
	}

	return strings.Join(parts, "\n\n")
}
