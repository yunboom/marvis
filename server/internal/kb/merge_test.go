package kb

import (
	"strings"
	"testing"
)

func contentOf(blocks []Block, id string) string {
	for _, b := range blocks {
		if b.ID == id {
			return b.Content
		}
	}

	return "<missing>"
}

func TestMergePageBlocks(t *testing.T) {
	base := PageVersion{Blocks: testBlocks("b1", "one", "b2", "two", "b3", "three", "b4", "four")}
	main := PageVersion{Blocks: testBlocks("b1", "one main", "b2", "two", "b3", "three main", "m1", "main new")}
	draft := PageVersion{Blocks: testBlocks("b1", "one", "b2", "two draft", "b3", "three draft", "b4", "four draft", "d1", "draft new")}

	got := MergePage(base, main, draft)

	if c := contentOf(got.Page.Blocks, "b1"); c != "one main" {
		t.Errorf("b1 only the mainline changed = %q", c)
	}
	if c := contentOf(got.Page.Blocks, "b2"); c != "two draft" {
		t.Errorf("b2 only the draft changed = %q", c)
	}
	if c := contentOf(got.Page.Blocks, "b3"); c != ConflictContent("three main", "three draft") {
		t.Errorf("b3 both changed = %q", c)
	}
	if c := contentOf(got.Page.Blocks, "b4"); c != ConflictContent("", "four draft") {
		t.Errorf("b4 deleted on the mainline, changed in the draft = %q", c)
	}

	order := idsOf(got.Page.Blocks)
	if order != "b1,b2,b3,m1,b4,d1" {
		t.Errorf("order = %s", order)
	}

	kinds := make([]string, 0)
	for _, c := range got.Conflicts {
		kinds = append(kinds, c.Kind+":"+c.BlockID)
	}
	if strings.Join(kinds, ",") != "block:b3,block:b4" {
		t.Errorf("conflicts = %v", kinds)
	}
	if got.Conflicts[0].MainLines != "5-5" || got.Conflicts[0].DraftLines != "5-5" {
		t.Errorf("b3 lines = %+v", got.Conflicts[0])
	}
}

func TestMergePageSameAnchorInsertsMainFirst(t *testing.T) {
	base := PageVersion{Blocks: testBlocks("b1", "one")}
	main := PageVersion{Blocks: testBlocks("b1", "one", "m1", "main")}
	draft := PageVersion{Blocks: testBlocks("b1", "one", "d1", "draft")}

	got := MergePage(base, main, draft)
	if idsOf(got.Page.Blocks) != "b1,m1,d1" || len(got.Conflicts) != 0 {
		t.Errorf("merge = %s %v", idsOf(got.Page.Blocks), got.Conflicts)
	}
}

func TestMergePageDraftDeletedUnchangedBlock(t *testing.T) {
	base := PageVersion{Blocks: testBlocks("b1", "one", "b2", "two")}
	main := PageVersion{Blocks: testBlocks("b1", "one main", "b2", "two")}
	draft := PageVersion{Blocks: testBlocks("b1", "one")}

	got := MergePage(base, main, draft)
	if idsOf(got.Page.Blocks) != "b1" || contentOf(got.Page.Blocks, "b1") != "one main" || len(got.Conflicts) != 0 {
		t.Errorf("merge = %+v %v", got.Page.Blocks, got.Conflicts)
	}
}

func TestMergePageHeaderAndPlacement(t *testing.T) {
	base := PageVersion{Slug: "a", Position: "a0", Frontmatter: map[string]any{"title": "T", "status": "draft", "tags": []any{"dev"}}}
	main := PageVersion{Slug: "b", Position: "a5", Frontmatter: map[string]any{"title": "T main", "status": "stable", "generated": "x"}}
	draft := PageVersion{Slug: "c", Position: "a0", Frontmatter: map[string]any{"title": "T", "status": "deprecated", "tags": []any{"dev"}}}

	got := MergePage(base, main, draft)
	header := got.Page.Frontmatter
	if header["title"] != "T main" || header["status"] != "deprecated" || header["generated"] != "x" {
		t.Errorf("header = %+v", header)
	}
	if _, ok := header["tags"]; ok {
		t.Errorf("tags removed on the mainline must stay removed: %+v", header)
	}
	if got.Page.Slug != "c" || got.Page.Position != "a5" {
		t.Errorf("placement = %s %s", got.Page.Slug, got.Page.Position)
	}

	kinds := make([]string, 0)
	for _, c := range got.Conflicts {
		kinds = append(kinds, c.Kind+":"+c.Key)
	}
	if strings.Join(kinds, ",") != "meta:status,move:" {
		t.Errorf("conflicts = %v", kinds)
	}
}

func TestMergePageDeletes(t *testing.T) {
	base := PageVersion{Blocks: testBlocks("b1", "one")}
	changed := PageVersion{Blocks: testBlocks("b1", "changed")}
	deleted := PageVersion{Deleted: true}

	if got := MergePage(base, deleted, base); !got.Page.Deleted || len(got.Conflicts) != 0 {
		t.Errorf("mainline delete of an untouched page = %+v", got)
	}
	if got := MergePage(base, deleted, changed); got.Page.Deleted || got.Conflicts[0].Kind != ConflictPage {
		t.Errorf("mainline delete of a changed page = %+v", got)
	}
	if got := MergePage(base, changed, deleted); got.Page.Deleted || contentOf(got.Page.Blocks, "b1") != "changed" || got.Conflicts[0].Kind != ConflictPage {
		t.Errorf("draft delete of a page the mainline changed = %+v", got)
	}
	if got := MergePage(base, base, deleted); !got.Page.Deleted || len(got.Conflicts) != 0 {
		t.Errorf("draft delete of an unchanged page = %+v", got)
	}
}

func TestMergeClaims(t *testing.T) {
	ev := []Evidence{{Source: "s", URI: "task://MAR-1"}}
	blocks := testBlocks("b1", "x", "b2", "y")
	base := PageVersion{Blocks: blocks, Claims: []Claim{{Key: "c1", BlockID: "b1", Text: "old", Evidence: ev}, {Key: "c2", BlockID: "b2", Text: "keep", Evidence: ev}}}
	main := PageVersion{Blocks: blocks, Claims: []Claim{{Key: "c1", BlockID: "b1", Text: "main", Evidence: ev}, {Key: "c3", BlockID: "b2", Text: "main new", Evidence: ev}}}
	draft := PageVersion{Blocks: blocks, Claims: []Claim{{Key: "c1", BlockID: "b1", Text: "old", Evidence: ev}, {Key: "c2", BlockID: "b2", Text: "keep", Evidence: ev}}}

	got := MergePage(base, main, draft)
	texts := make([]string, 0)
	for _, c := range got.Page.Claims {
		texts = append(texts, c.Key+"="+c.Text)
	}
	if strings.Join(texts, ",") != "c1=main,c3=main new" {
		t.Errorf("claims = %v", texts)
	}
}

func TestBlockLines(t *testing.T) {
	blocks := testBlocks("b1", "# T", "b2", "a\nb")
	if r := BlockLineRanges(blocks); r["b1"] != "1-1" || r["b2"] != "3-4" {
		t.Errorf("ranges = %v", r)
	}
	if got := strings.Join(BlockOfLines(blocks), ","); got != "b1,,b2,b2" {
		t.Errorf("lines = %s", got)
	}
}
