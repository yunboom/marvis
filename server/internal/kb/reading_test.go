package kb

import (
	"reflect"
	"strings"
	"testing"
)

func TestCursorRoundTrip(t *testing.T) {
	c := PageCursor{Position: "a1", ID: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"}

	got, ok, err := DecodeCursor(EncodeCursor(c))
	if err != nil || !ok || got != c {
		t.Fatalf("DecodeCursor(EncodeCursor(%+v)) = %+v, %v, %v", c, got, ok, err)
	}

	if _, ok, err := DecodeCursor(""); ok || err != nil {
		t.Fatalf("empty cursor = %v, %v; want start of list", ok, err)
	}
	for _, bad := range []string{"%%%", "bm90IGpzb24", EncodeCursor(PageCursor{Position: "a", ID: "x"})} {
		if _, _, err := DecodeCursor(bad); err != ErrInvalidCursor {
			t.Errorf("DecodeCursor(%q) error = %v, want ErrInvalidCursor", bad, err)
		}
	}
}

func TestCursorAfter(t *testing.T) {
	c := PageCursor{Position: "b", ID: "2"}

	cases := []struct {
		position, id string
		want         bool
	}{
		{"a", "9", false},
		{"b", "1", false},
		{"b", "2", false},
		{"b", "3", true},
		{"c", "0", true},
	}
	for _, tc := range cases {
		if got := c.After(tc.position, tc.id); got != tc.want {
			t.Errorf("After(%q, %q) = %v, want %v", tc.position, tc.id, got, tc.want)
		}
	}
}

func TestLineDiff(t *testing.T) {
	oldText := []string{"# 回调", "", "每 30 分钟补查。", "验签失败丢弃。"}
	newText := []string{"# 回调", "", "每 10 分钟补查。[^2]", "验签失败丢弃。", "", "[^2]: task://MAR-128"}

	diff := LineDiff(oldText, newText)
	want := []DiffLine{
		{Op: DiffEqual, OldLine: 1, NewLine: 1, Text: "# 回调"},
		{Op: DiffEqual, OldLine: 2, NewLine: 2, Text: ""},
		{Op: DiffDeleted, OldLine: 3, Text: "每 30 分钟补查。"},
		{Op: DiffAdded, NewLine: 3, Text: "每 10 分钟补查。[^2]"},
		{Op: DiffEqual, OldLine: 4, NewLine: 4, Text: "验签失败丢弃。"},
		{Op: DiffAdded, NewLine: 5, Text: ""},
		{Op: DiffAdded, NewLine: 6, Text: "[^2]: task://MAR-128"},
	}
	if !reflect.DeepEqual(diff, want) {
		t.Fatalf("LineDiff =\n%+v\nwant\n%+v", diff, want)
	}
	if s := Stats(diff); s != (DiffStats{Added: 3, Deleted: 1}) {
		t.Fatalf("Stats = %+v", s)
	}
}

func TestLineDiffEdges(t *testing.T) {
	if got := Stats(LineDiff(nil, SplitLines("a\nb"))); got != (DiffStats{Added: 2}) {
		t.Errorf("from empty = %+v, want 2 added", got)
	}
	if got := Stats(LineDiff(SplitLines("a\nb"), nil)); got != (DiffStats{Deleted: 2}) {
		t.Errorf("to empty = %+v, want 2 deleted", got)
	}
	if got := Stats(LineDiff(SplitLines("a\nb"), SplitLines("a\nb"))); got != (DiffStats{}) {
		t.Errorf("identical = %+v, want no changes", got)
	}
}

func TestHunks(t *testing.T) {
	oldLines := make([]string, 0, 30)
	for i := 0; i < 30; i++ {
		oldLines = append(oldLines, "line")
	}
	oldLines[0] = "## 处理顺序"
	oldLines[20] = "## 去重"
	newLines := append([]string(nil), oldLines...)
	newLines[2] = "changed early"
	newLines[25] = "changed late"

	hunks := Hunks(LineDiff(oldLines, newLines), 3)
	if len(hunks) != 2 {
		t.Fatalf("hunks = %d, want 2 separate hunks", len(hunks))
	}
	if hunks[0].Heading != "处理顺序" || hunks[1].Heading != "去重" {
		t.Errorf("headings = %q, %q", hunks[0].Heading, hunks[1].Heading)
	}
	// Two changed lines (delete + add) plus three context lines each side,
	// clipped at the top of the page for the first hunk.
	if len(hunks[0].Lines) != 2+2+3 || len(hunks[1].Lines) != 3+2+3 {
		t.Errorf("hunk sizes = %d, %d", len(hunks[0].Lines), len(hunks[1].Lines))
	}

	near := append([]string(nil), oldLines...)
	near[5] = "a"
	near[9] = "b"
	if got := Hunks(LineDiff(oldLines, near), 3); len(got) != 1 {
		t.Errorf("changes 4 lines apart = %d hunks, want 1", len(got))
	}
	if got := Hunks(LineDiff(oldLines, oldLines), 3); len(got) != 0 {
		t.Errorf("no change = %d hunks, want 0", len(got))
	}
}

func TestSourcesFromClaims(t *testing.T) {
	blocks := []Block{{ID: "b1"}, {ID: "b2"}}
	claims := []Claim{
		{Key: "c2", BlockID: "b2", Evidence: []Evidence{
			{Source: "spec", URI: "raw://sources/channel%20v3.pdf#page=12", Title: "渠道接入规范 v3"},
			{Source: "mar-142", URI: "task://MAR-142", Title: "重复"},
		}},
		{Key: "c1", BlockID: "b1", Evidence: []Evidence{
			{Source: "mar-142", URI: "task://MAR-142", Title: "回调改用渠道交易号去重", Version: "2026-10-20"},
			{Source: "", URI: "https://ignored"},
		}},
		{Key: "c3", BlockID: "gone", Evidence: []Evidence{{Source: "web", URI: "https://example.com"}}},
	}

	got := SourcesFromClaims(blocks, claims)
	want := []Source{
		{ID: "mar-142", Kind: SourceKindTask, URI: "task://MAR-142", Title: "回调改用渠道交易号去重", Version: "2026-10-20"},
		{ID: "spec", Kind: SourceKindRaw, URI: "raw://sources/channel%20v3.pdf#page=12", Title: "渠道接入规范 v3"},
		{ID: "web", Kind: SourceKindWeb, URI: "https://example.com"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SourcesFromClaims =\n%+v\nwant\n%+v", got, want)
	}
}

func TestSourceURIs(t *testing.T) {
	kinds := map[string]string{
		"task://MAR-1":       SourceKindTask,
		"chat://abc":         SourceKindChat,
		"pr://repo/12":       SourceKindPR,
		"repo://a.go#L1-L2":  SourceKindRepo,
		"raw://sources/a":    SourceKindRaw,
		"HTTPS://x.com":      SourceKindWeb,
		"ftp://x":            SourceKindOther,
		"no scheme at all":   SourceKindOther,
		"http://example.com": SourceKindWeb,
	}
	for uri, want := range kinds {
		if got := SourceKind(uri); got != want {
			t.Errorf("SourceKind(%q) = %q, want %q", uri, got, want)
		}
	}

	if ref, ok := ParseRawURI("raw://sources/channel%20v3.pdf#page=12"); !ok || ref != (RawRef{Kind: RawKindSource, Name: "channel v3.pdf", Page: 12}) {
		t.Errorf("ParseRawURI = %+v, %v", ref, ok)
	}
	if ref, ok := ParseRawURI("raw://assets/diagram.png"); !ok || ref != (RawRef{Kind: RawKindAsset, Name: "diagram.png"}) {
		t.Errorf("ParseRawURI asset = %+v, %v", ref, ok)
	}
	for _, bad := range []string{"raw://other/a.pdf", "raw://sources/", "task://MAR-1"} {
		if _, ok := ParseRawURI(bad); ok {
			t.Errorf("ParseRawURI(%q) ok, want false", bad)
		}
	}

	if n, ok := ParseTaskURI("task://MAR-142"); !ok || n != 142 {
		t.Errorf("ParseTaskURI = %d, %v", n, ok)
	}
	for _, bad := range []string{"task://MAR", "task://MAR-x", "task://MAR-0", "chat://x"} {
		if _, ok := ParseTaskURI(bad); ok {
			t.Errorf("ParseTaskURI(%q) ok, want false", bad)
		}
	}
	if id, ok := ParseChatURI("chat://s1"); !ok || id != "s1" {
		t.Errorf("ParseChatURI = %q, %v", id, ok)
	}
}

func TestMergeLevel(t *testing.T) {
	mainline := []LevelPage{{ID: "1", Position: "a"}, {ID: "3", Position: "c"}, {ID: "5", Position: "e"}}
	draft := []LevelPage{
		{ID: "0", Position: "0", DraftChange: DraftChangeAdded},
		{ID: "2", Position: "b", DraftChange: DraftChangeMoved},
		{ID: "4", Position: "d", DraftChange: DraftChangeDeleted},
	}

	page, more := MergeLevel(mainline, draft, &PageCursor{Position: "0", ID: "0"}, 3)
	if !more || ids(page) != "1,2,3" {
		t.Fatalf("first page = %s more=%v, want 1,2,3 more", ids(page), more)
	}
	if page[1].DraftChange != DraftChangeMoved {
		t.Errorf("draft entry lost its change: %+v", page[1])
	}

	page, more = MergeLevel(mainline[2:], draft, &PageCursor{Position: "c", ID: "3"}, 3)
	if more || ids(page) != "4,5" {
		t.Fatalf("second page = %s more=%v, want 4,5 and no more", ids(page), more)
	}

	page, _ = MergeLevel(nil, draft, nil, 10)
	if ids(page) != "0,2,4" {
		t.Fatalf("no cursor = %s, want every draft entry", ids(page))
	}
}

func ids(pages []LevelPage) string {
	out := make([]string, len(pages))
	for i, p := range pages {
		out[i] = p.ID
	}

	return strings.Join(out, ",")
}

func TestChildCounts(t *testing.T) {
	mainline := map[string]int64{"p": 2, "q": 0}
	placements := []DraftPlacement{
		{PageID: "x", ParentID: "q", MainParentID: "p", OnMainline: true}, // moved p -> q
		{PageID: "y", ParentID: "q", OnMainline: false},                   // created under q
		{PageID: "z", ParentID: "p", MainParentID: "p", OnMainline: true}, // edited in place
		{PageID: "w", ParentID: "", MainParentID: "", OnMainline: true},   // top level, untouched counts
	}

	got := ChildCounts([]string{"p", "q"}, mainline, placements)
	if got["p"] != 1 || got["q"] != 2 {
		t.Fatalf("ChildCounts = %v, want p=1 q=2", got)
	}
}

func TestDraftChange(t *testing.T) {
	cases := map[string]string{
		DraftOpCreate: DraftChangeAdded,
		DraftOpUpdate: DraftChangeModified,
		DraftOpMove:   DraftChangeMoved,
		DraftOpDelete: DraftChangeDeleted,
		"unknown":     DraftChangeNone,
	}
	for op, want := range cases {
		if got := DraftChange(op); got != want {
			t.Errorf("DraftChange(%q) = %q, want %q", op, got, want)
		}
	}
}

func TestParsePageRef(t *testing.T) {
	cases := map[string]PageRef{
		"team:/payment/callback.md":            {KbSlug: "team", Path: "/payment/callback"},
		"/payment":                             {Path: "/payment"},
		"team:/":                               {KbSlug: "team", Path: "/"},
		"0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f": {PageID: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"},
	}
	for ref, want := range cases {
		if got := ParsePageRef(ref); got != want {
			t.Errorf("ParsePageRef(%q) = %+v, want %+v", ref, got, want)
		}
	}
}

func TestRouteAndPathLinks(t *testing.T) {
	const pageID = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
	blocks := []Block{{ID: "b1", Kind: BlockKindText, Content: "见[幂等键](kb://" + pageID + "#b9Lm)、[退款](/payment/refund.md)和[官网](https://x.com)。"}}

	routed := RouteLinks(blocks, "team")
	want := "见[幂等键](/kb/team/p/" + pageID + "#b9Lm)、[退款](/payment/refund.md)和[官网](https://x.com)。"
	if routed[0].Content != want {
		t.Errorf("RouteLinks = %q, want %q", routed[0].Content, want)
	}

	tree := NewPageTree([]TreeNode{{ID: pageID, Slug: "idempotency"}})
	paths := PathLinks(blocks, tree)
	if !strings.Contains(paths[0].Content, "](/idempotency.md#^b9Lm)") {
		t.Errorf("PathLinks = %q", paths[0].Content)
	}
	if blocks[0].Content == routed[0].Content {
		t.Error("RouteLinks modified its input")
	}
}

func TestPageTreeAncestors(t *testing.T) {
	tree := NewPageTree([]TreeNode{
		{ID: "a", Slug: "product", Title: "产品与业务"},
		{ID: "b", ParentID: "a", Slug: "payment", Title: "支付"},
		{ID: "c", ParentID: "b", Slug: "callback", Title: "支付回调"},
		{ID: "x", ParentID: "y", Slug: "loop"},
		{ID: "y", ParentID: "x", Slug: "loop"},
	})

	got := tree.Ancestors("c")
	if len(got) != 2 || got[0].Title != "产品与业务" || got[1].Title != "支付" {
		t.Fatalf("Ancestors(c) = %+v", got)
	}
	if got := tree.Ancestors("a"); len(got) != 0 {
		t.Errorf("Ancestors(top) = %+v, want none", got)
	}
	if got := tree.Ancestors("x"); len(got) != 1 {
		t.Errorf("Ancestors(cycle) = %+v, want the chain cut at the loop", got)
	}
}

func TestChangedBlockCount(t *testing.T) {
	mainline := []Block{{ID: "b1", Content: "a"}, {ID: "b2", Content: "b"}, {ID: "b3", Content: "c"}}
	draft := []Block{{ID: "b1", Content: "a"}, {ID: "b2", Content: "B"}, {ID: "b4", Content: "new"}}

	if got := ChangedBlockCount(mainline, draft); got != 3 {
		t.Fatalf("ChangedBlockCount = %d, want 3 (edit, add, remove)", got)
	}
}

func TestParseFrontmatter(t *testing.T) {
	header, fm, err := ParseFrontmatter([]byte(`{"type":"Workflow","title":"支付回调","tags":["dev"],"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if fm.Type != "Workflow" || fm.Title != "支付回调" || header["x"] != float64(1) {
		t.Fatalf("ParseFrontmatter = %+v, %+v", header, fm)
	}
	if _, _, err := ParseFrontmatter([]byte("[")); err == nil {
		t.Fatal("malformed frontmatter parsed")
	}
}
