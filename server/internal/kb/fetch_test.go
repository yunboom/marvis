package kb

import (
	"errors"
	"testing"
)

func TestSelectBlocks(t *testing.T) {
	page := testBlocks(
		"b1", "# Title",
		"b2", "intro",
		"b3", "## Dedup",
		"b4", "by trade no",
		"b5", "### Detail",
		"b6", "key ttl",
		"b7", "## Related",
		"b8", "- links",
	)

	cases := []struct {
		name  string
		scope FetchScope
		want  string
	}{
		{"full", FetchScope{}, "b1,b2,b3,b4,b5,b6,b7,b8"},
		{"outline", FetchScope{Scope: ScopeOutline}, "b1,b3,b5,b7"},
		{"outline depth", FetchScope{Scope: ScopeOutline, MaxDepth: 2}, "b1,b3,b7"},
		{"section", FetchScope{Scope: ScopeSection, StartBlockID: "b3"}, "b3,b4,b5,b6"},
		{"section with context", FetchScope{Scope: ScopeSection, StartBlockID: "b5", ContextBefore: 1, ContextAfter: 1}, "b4,b5,b6,b7"},
		{"keyword", FetchScope{Scope: ScopeKeyword, Keyword: "TRADE|ttl"}, "b4,b6"},
		{"range", FetchScope{Scope: ScopeRange, StartBlockID: "b2", EndBlockID: "b4"}, "b2,b3,b4"},
		{"range to end", FetchScope{Scope: ScopeRange, StartBlockID: "b7"}, "b7,b8"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, truncated, err := SelectBlocks(page, c.scope)
			if err != nil || truncated || idsOf(got) != c.want {
				t.Errorf("SelectBlocks = %s truncated=%v err=%v, want %s", idsOf(got), truncated, err, c.want)
			}
		})
	}

	for name, s := range map[string]FetchScope{
		"section not heading":  {Scope: ScopeSection, StartBlockID: "b2"},
		"section without id":   {Scope: ScopeSection},
		"keyword without word": {Scope: ScopeKeyword, Keyword: " | "},
		"range reversed":       {Scope: ScopeRange, StartBlockID: "b4", EndBlockID: "b2"},
		"unknown scope":        {Scope: "page"},
	} {
		if _, _, err := SelectBlocks(page, s); !errors.Is(err, ErrInvalidFetch) {
			t.Errorf("%s err = %v, want ErrInvalidFetch", name, err)
		}
	}
	if _, _, err := SelectBlocks(page, FetchScope{Scope: ScopeRange, StartBlockID: "b404"}); !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("missing block err = %v", err)
	}
}

func TestSelectBlocksTruncates(t *testing.T) {
	page := make([]Block, MaxFetchBlocks+5)
	for i := range page {
		page[i] = Block{ID: "b" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Content: "x"}
	}

	got, truncated, err := SelectBlocks(page, FetchScope{})
	if err != nil || !truncated || len(got) != MaxFetchBlocks {
		t.Errorf("len=%d truncated=%v err=%v", len(got), truncated, err)
	}
}

func TestPageLinks(t *testing.T) {
	tree := NewPageTree([]TreeNode{
		{ID: "11111111-1111-4111-8111-111111111111", Slug: "a"},
		{ID: "22222222-2222-4222-8222-222222222222", Slug: "b"},
	})
	blocks := testBlocks(
		"b1", "[a](/a.md) [again](kb://11111111-1111-4111-8111-111111111111#b9) [self](/b.md)",
		"b2", "[todo](/todo.md) [web](https://x.dev) [gone](kb://33333333-3333-4333-8333-333333333333)",
	)

	ids, unresolved := PageLinks(blocks, "22222222-2222-4222-8222-222222222222", tree)
	if len(ids) != 1 || ids[0] != "11111111-1111-4111-8111-111111111111" {
		t.Errorf("linked = %v", ids)
	}
	if len(unresolved) != 1 || unresolved[0] != "/todo" {
		t.Errorf("unresolved = %v", unresolved)
	}
}
