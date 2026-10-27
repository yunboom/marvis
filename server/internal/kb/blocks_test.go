package kb

import (
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestSplitMarkdown(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want []string
	}{
		{
			name: "empty",
			src:  "  \n\n",
			want: []string{},
		},
		{
			name: "heading and paragraphs",
			src:  "## 去重\n\n按渠道交易号去重。[^mar-142]\n\n第二段\n跨两行。\n",
			want: []string{"## 去重", "按渠道交易号去重。[^mar-142]", "第二段\n跨两行。"},
		},
		{
			name: "whole list is one block",
			src:  "- a\n- b\n\n  continued\n- c\n\nafter",
			want: []string{"- a\n- b\n\n  continued\n- c", "after"},
		},
		{
			name: "fenced code keeps fences and blank lines",
			src:  "```go\nfunc a() {}\n\nfunc b() {}\n```\ntext",
			want: []string{"```go\nfunc a() {}\n\nfunc b() {}\n```", "text"},
		},
		{
			name: "empty fenced code",
			src:  "```\n```\n\nnext",
			want: []string{"```\n```", "next"},
		},
		{
			name: "block quote is one block",
			src:  "> quoted\n> more\n\n> second quote",
			want: []string{"> quoted\n> more", "> second quote"},
		},
		{
			name: "table is one block",
			src:  "| 我要 | 打开 |\n| --- | --- |\n| 回调 | /payment |\n\n下文",
			want: []string{"| 我要 | 打开 |\n| --- | --- |\n| 回调 | /payment |", "下文"},
		},
		{
			name: "heading directly followed by paragraph",
			src:  "# Title\nbody",
			want: []string{"# Title", "body"},
		},
		{
			name: "setext heading and thematic break",
			src:  "Title\n=====\n\n---\n\nbody",
			want: []string{"Title\n=====", "---", "body"},
		},
		{
			name: "indented code block keeps indentation",
			src:  "para\n\n    code line\n    more",
			want: []string{"para", "    code line\n    more"},
		},
		{
			name: "reference definition is its own block",
			src:  "see [x][r]\n\n[r]: https://example.com\n\nnext",
			want: []string{"see [x][r]", "[r]: https://example.com", "next"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SplitMarkdown(tc.src)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("SplitMarkdown() = %q, want %q", got, tc.want)
			}
		})
	}
}

var blockIDPattern = regexp.MustCompile(`^b[0-9A-Za-z]{3}$`)

func TestBlockIDAllocatorAvoidsUsedIDs(t *testing.T) {
	used := make([]string, 0, len(blockIDAlphabet))
	for _, c := range blockIDAlphabet[1:] {
		used = append(used, "b00"+string(c))
	}
	ids := NewBlockIDAllocator(used)

	seen := make(map[string]struct{})
	for range 2000 {
		id, err := ids.Next()
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		if !blockIDPattern.MatchString(id) {
			t.Fatalf("Next() = %q, want 4-character id like b7Kq", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("Next() returned %q twice", id)
		}
		for _, u := range used {
			if id == u {
				t.Fatalf("Next() returned used id %q", id)
			}
		}
		seen[id] = struct{}{}
	}
}

func TestBlockIDAllocatorExhausted(t *testing.T) {
	used := make([]string, 0, 238328)
	for _, a := range blockIDAlphabet {
		for _, b := range blockIDAlphabet {
			for _, c := range blockIDAlphabet {
				used = append(used, "b"+string(a)+string(b)+string(c))
			}
		}
	}

	_, err := NewBlockIDAllocator(used).Next()
	if !errors.Is(err, ErrBlockIDsExhausted) {
		t.Fatalf("Next() error = %v, want ErrBlockIDsExhausted", err)
	}
}

func TestNewBlocks(t *testing.T) {
	blocks, err := NewBlocks("# A\n\nbody", NewBlockIDAllocator(nil))
	if err != nil {
		t.Fatalf("NewBlocks() error = %v", err)
	}
	if len(blocks) != 2 || blocks[0].Content != "# A" || blocks[1].Content != "body" {
		t.Fatalf("NewBlocks() = %+v", blocks)
	}
	for _, block := range blocks {
		if block.Kind != BlockKindText || !blockIDPattern.MatchString(block.ID) {
			t.Fatalf("block = %+v, want kind text and a 4-character id", block)
		}
	}
	if blocks[0].ID == blocks[1].ID {
		t.Fatalf("blocks share id %q", blocks[0].ID)
	}
}

func TestReplaceBlock(t *testing.T) {
	page := []Block{
		{ID: "b7Kq", Kind: BlockKindText, Content: "## 去重"},
		{ID: "b8Xz", Kind: BlockKindText, Content: "old"},
		{ID: "b9Ln", Kind: BlockKindText, Content: "tail"},
	}

	t.Run("single block keeps id", func(t *testing.T) {
		ids := NewBlockIDAllocator([]string{"b7Kq", "b8Xz", "b9Ln"})
		got, newIDs, err := ReplaceBlock(page, "b8Xz", "new text\n", ids)
		if err != nil {
			t.Fatalf("ReplaceBlock() error = %v", err)
		}
		want := []Block{page[0], {ID: "b8Xz", Kind: BlockKindText, Content: "new text"}, page[2]}
		if !reflect.DeepEqual(got, want) || len(newIDs) != 0 {
			t.Fatalf("ReplaceBlock() = %+v, %v", got, newIDs)
		}
		if page[1].Content != "old" {
			t.Fatal("ReplaceBlock() mutated its input")
		}
	})

	t.Run("split keeps first id and inserts the rest in order", func(t *testing.T) {
		ids := NewBlockIDAllocator([]string{"b7Kq", "b8Xz", "b9Ln"})
		got, newIDs, err := ReplaceBlock(page, "b8Xz", "first\n\n- x\n- y\n\nthird", ids)
		if err != nil {
			t.Fatalf("ReplaceBlock() error = %v", err)
		}
		if len(got) != 5 || len(newIDs) != 2 {
			t.Fatalf("ReplaceBlock() = %+v, new ids %v", got, newIDs)
		}
		contents := []string{got[0].Content, got[1].Content, got[2].Content, got[3].Content, got[4].Content}
		if strings.Join(contents, "|") != "## 去重|first|- x\n- y|third|tail" {
			t.Fatalf("contents = %q", contents)
		}
		if got[1].ID != "b8Xz" || got[2].ID != newIDs[0] || got[3].ID != newIDs[1] {
			t.Fatalf("ids = %s %s %s, new %v", got[1].ID, got[2].ID, got[3].ID, newIDs)
		}
		for _, id := range newIDs {
			if id == "b7Kq" || id == "b8Xz" || id == "b9Ln" {
				t.Fatalf("new id %q collides with an existing block", id)
			}
		}
	})

	t.Run("unknown block", func(t *testing.T) {
		_, _, err := ReplaceBlock(page, "bNOP", "x", NewBlockIDAllocator(nil))
		if !errors.Is(err, ErrBlockNotFound) {
			t.Fatalf("error = %v, want ErrBlockNotFound", err)
		}
	})

	t.Run("empty content", func(t *testing.T) {
		_, _, err := ReplaceBlock(page, "b8Xz", " \n", NewBlockIDAllocator(nil))
		if !errors.Is(err, ErrEmptyBlockContent) {
			t.Fatalf("error = %v, want ErrEmptyBlockContent", err)
		}
	})
}

func TestJoinBlocksRoundTrip(t *testing.T) {
	src := "# A\n\npara one\n\n- x\n- y\n\n```\ncode\n```"
	blocks, err := NewBlocks(src, NewBlockIDAllocator(nil))
	if err != nil {
		t.Fatalf("NewBlocks() error = %v", err)
	}
	if got := JoinBlocks(blocks); got != src {
		t.Fatalf("JoinBlocks() = %q, want %q", got, src)
	}
}
