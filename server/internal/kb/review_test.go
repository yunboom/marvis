package kb

import (
	"reflect"
	"strings"
	"testing"
)

// TestMergePageMatrix walks the rows of the spec 6.3 merge table, one case
// per row, as merging a draft into the mainline sees them.
func TestMergePageMatrix(t *testing.T) {
	page := func(blocks ...string) PageVersion {
		return PageVersion{
			ParentID: "p", Position: "a0", Slug: "s",
			Frontmatter: map[string]any{"title": "T", "type": "Guide"},
			Blocks:      testBlocks(blocks...),
		}
	}
	base := page("b1", "one", "b2", "two")

	cases := []struct {
		name      string
		main      PageVersion
		draft     PageVersion
		wantOrder string
		want      map[string]string
		conflicts string
	}{
		{
			name:  "mainline untouched: the draft as is",
			main:  base,
			draft: page("b1", "one draft", "b2", "two"),
			want:  map[string]string{"b1": "one draft", "b2": "two"},
		},
		{
			name:  "different blocks: both changes",
			main:  page("b1", "one main", "b2", "two"),
			draft: page("b1", "one", "b2", "two draft"),
			want:  map[string]string{"b1": "one main", "b2": "two draft"},
		},
		{
			name:  "same block, same result: no conflict",
			main:  page("b1", "one new", "b2", "two"),
			draft: page("b1", "one new", "b2", "two"),
			want:  map[string]string{"b1": "one new"},
		},
		{
			name:      "both insert at the same place: mainline first",
			main:      page("b1", "one", "m1", "main", "b2", "two"),
			draft:     page("b1", "one", "d1", "draft", "b2", "two"),
			wantOrder: "b1,m1,d1,b2",
		},
		{
			name:      "same block, different results: conflict",
			main:      page("b1", "one main", "b2", "two"),
			draft:     page("b1", "one draft", "b2", "two"),
			want:      map[string]string{"b1": ConflictContent("one main", "one draft")},
			conflicts: "block:b1",
		},
		{
			name:      "mainline deleted a block the draft changed",
			main:      page("b2", "two"),
			draft:     page("b1", "one draft", "b2", "two"),
			conflicts: "block:b1",
		},
		{
			name:      "draft deleted a block the mainline changed",
			main:      page("b1", "one main", "b2", "two"),
			draft:     page("b2", "two"),
			conflicts: "block:b1",
		},
		{
			name:      "both deleted the same block",
			main:      page("b2", "two"),
			draft:     page("b2", "two"),
			wantOrder: "b2",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MergePage(base, tc.main, tc.draft)

			for id, want := range tc.want {
				if c := contentOf(got.Page.Blocks, id); c != want {
					t.Errorf("%s = %q, want %q", id, c, want)
				}
			}
			if tc.wantOrder != "" && idsOf(got.Page.Blocks) != tc.wantOrder {
				t.Errorf("order = %s, want %s", idsOf(got.Page.Blocks), tc.wantOrder)
			}
			kinds := make([]string, 0, len(got.Conflicts))
			for _, c := range got.Conflicts {
				kinds = append(kinds, c.Kind+":"+c.BlockID)
			}
			if strings.Join(kinds, ",") != tc.conflicts {
				t.Errorf("conflicts = %v, want %q", kinds, tc.conflicts)
			}
		})
	}

	t.Run("header keys merge three ways", func(t *testing.T) {
		main := page("b1", "one", "b2", "two")
		main.Frontmatter = map[string]any{"title": "T", "type": "Guide", "owner": "main"}
		draft := page("b1", "one", "b2", "two")
		draft.Frontmatter = map[string]any{"title": "T draft", "type": "Guide"}
		if got := MergePage(base, main, draft); got.Page.Frontmatter["owner"] != "main" || got.Page.Frontmatter["title"] != "T draft" || len(got.Conflicts) != 0 {
			t.Errorf("different keys = %+v", got)
		}

		main.Frontmatter = map[string]any{"title": "T main", "type": "Guide"}
		got := MergePage(base, main, draft)
		if got.Page.Frontmatter["title"] != "T draft" || len(got.Conflicts) != 1 || got.Conflicts[0].Kind != ConflictMeta || got.Conflicts[0].Key != "title" {
			t.Errorf("same key both sides = %+v", got)
		}
	})

	t.Run("claims merge by key", func(t *testing.T) {
		main := page("b1", "one", "b2", "two")
		main.Claims = []Claim{{Key: "c1", BlockID: "b1", Text: "main"}}
		draft := page("b1", "one", "b2", "two")
		draft.Claims = []Claim{{Key: "c2", BlockID: "b2", Text: "draft"}}
		got := MergePage(base, main, draft)
		if len(got.Page.Claims) != 2 || got.Page.Claims[0].Key != "c1" || got.Page.Claims[1].Key != "c2" {
			t.Errorf("claims = %+v", got.Page.Claims)
		}
	})

	t.Run("move and rename merge by field", func(t *testing.T) {
		main := page("b1", "one", "b2", "two")
		main.ParentID = "q"
		draft := page("b1", "one", "b2", "two")
		draft.Slug = "renamed"
		got := MergePage(base, main, draft)
		if got.Page.ParentID != "q" || got.Page.Slug != "renamed" || len(got.Conflicts) != 0 {
			t.Errorf("different fields = %+v", got)
		}

		main.Slug = "other"
		if got := MergePage(base, main, draft); len(got.Conflicts) != 1 || got.Conflicts[0].Kind != ConflictMove || got.Page.Slug != "renamed" {
			t.Errorf("same field both sides = %+v", got)
		}
	})

	t.Run("one side deleted the page, the other changed it", func(t *testing.T) {
		deleted := base
		deleted.Deleted = true
		changed := page("b1", "one changed", "b2", "two")

		if got := MergePage(base, deleted, changed); got.Page.Deleted || len(got.Conflicts) != 1 || got.Conflicts[0].Kind != ConflictPage {
			t.Errorf("mainline deleted = %+v", got)
		}
		if got := MergePage(base, changed, deleted); got.Page.Deleted || len(got.Conflicts) != 1 || got.Conflicts[0].Kind != ConflictPage {
			t.Errorf("draft deleted = %+v", got)
		}
		if got := MergePage(base, base, deleted); !got.Page.Deleted || len(got.Conflicts) != 0 {
			t.Errorf("draft deleted an untouched page = %+v", got)
		}
	})
}

func TestRevertPage(t *testing.T) {
	page := func(blocks ...string) PageVersion {
		return PageVersion{Slug: "s", Frontmatter: map[string]any{"title": "T"}, Blocks: testBlocks(blocks...)}
	}
	before := page("b1", "one", "b2", "two")
	after := page("b1", "one merged", "b2", "two")

	if got := RevertPage(before, after, after, true); !reflect.DeepEqual(got.Page, before) || len(got.Conflicts) != 0 {
		t.Errorf("mainline still at the merge = %+v", got)
	}

	later := page("b1", "one merged", "b2", "two later")
	got := RevertPage(before, after, later, false)
	if contentOf(got.Page.Blocks, "b1") != "one" || contentOf(got.Page.Blocks, "b2") != "two later" || len(got.Conflicts) != 0 {
		t.Errorf("later change elsewhere = %+v", got)
	}

	touched := page("b1", "one rewritten", "b2", "two")
	if got := RevertPage(before, after, touched, false); len(got.Conflicts) != 1 || got.Conflicts[0].BlockID != "b1" {
		t.Errorf("later change to the same block = %+v", got)
	}

	created := PageVersion{Slug: "s", Deleted: true}
	if got := RevertPage(created, after, after, true); !got.Page.Deleted {
		t.Errorf("reverting a created page = %+v", got)
	}
	if got := RevertPage(created, after, later, false); got.Page.Deleted || len(got.Conflicts) != 1 || got.Conflicts[0].Kind != ConflictPage {
		t.Errorf("reverting a created page changed since = %+v", got)
	}
}
