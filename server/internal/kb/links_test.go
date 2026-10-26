package kb

import (
	"reflect"
	"testing"
)

const (
	testPagePayment  = "11223344-5566-4778-8899-aabbccddeeff"
	testPageCallback = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
	testPageIdem     = "22334455-6677-4889-9aab-bccddeeff001"
)

func testTree() *PageTree {
	return NewPageTree([]TreeNode{
		{ID: testPagePayment, Slug: "payment"},
		{ID: testPageCallback, ParentID: testPagePayment, Slug: "callback"},
		{ID: testPageIdem, ParentID: testPagePayment, Slug: "idempotency"},
	})
}

func TestParseLinkTarget(t *testing.T) {
	cases := []struct {
		dest   string
		want   LinkTarget
		wantOK bool
	}{
		{dest: "/payment/idempotency.md", want: LinkTarget{Path: "/payment/idempotency"}, wantOK: true},
		{dest: "/payment/idempotency.md#^b9Lm", want: LinkTarget{Path: "/payment/idempotency", BlockID: "b9Lm"}, wantOK: true},
		{dest: "/payment/idempotency", want: LinkTarget{Path: "/payment/idempotency"}, wantOK: true},
		{dest: "/支付/%E5%9B%9E%E8%B0%83.md", want: LinkTarget{Path: "/支付/回调"}, wantOK: true},
		{dest: "kb://" + testPageIdem + "#b9Lm", want: LinkTarget{PageID: testPageIdem, BlockID: "b9Lm"}, wantOK: true},
		{dest: "kb://" + testPageIdem, want: LinkTarget{PageID: testPageIdem}, wantOK: true},
		{dest: "kb://not-a-uuid"},
		{dest: "https://example.com/a.md"},
		{dest: "//cdn.example.com/a.md"},
		{dest: "raw://sources/spec.pdf#page=12"},
		{dest: "relative/page.md"},
		{dest: "/"},
	}

	for _, tc := range cases {
		t.Run(tc.dest, func(t *testing.T) {
			got, ok := ParseLinkTarget(tc.dest)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("ParseLinkTarget(%q) = %+v, %v; want %+v, %v", tc.dest, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestFormatLinks(t *testing.T) {
	if got := FormatPageLink(testPageIdem, "b9Lm"); got != "kb://"+testPageIdem+"#b9Lm" {
		t.Fatalf("FormatPageLink() = %q", got)
	}
	if got := FormatPageLink(testPageIdem, ""); got != "kb://"+testPageIdem {
		t.Fatalf("FormatPageLink() = %q", got)
	}
	if got := FormatPathLink("payment/idempotency", "b9Lm"); got != "/payment/idempotency.md#^b9Lm" {
		t.Fatalf("FormatPathLink() = %q", got)
	}
}

func TestResolveLinks(t *testing.T) {
	blocks := []Block{
		{ID: "b1aa", Kind: BlockKindText, Content: "见[幂等键](/payment/idempotency.md#^b9Lm)和[回调](/payment/callback.md \"title\")。"},
		{ID: "b2bb", Kind: BlockKindText, Content: "[待写](/payment/refund.md) [外链](https://example.com) [资料](raw://sources/a.pdf)"},
		{ID: "b3cc", Kind: BlockKindText, Content: "已存 [链接](kb://" + testPageCallback + "#b8Xz) 和 `[代码](/payment/callback.md)`"},
		{ID: "b4dd", Kind: BlockKindText, Content: "- [a](</payment/idempotency.md>)\n- [b](/payment/idempotency.md)"},
	}

	got, links := ResolveLinks(blocks, testTree())

	wantContent := []string{
		"见[幂等键](kb://" + testPageIdem + "#b9Lm)和[回调](kb://" + testPageCallback + " \"title\")。",
		"[待写](/payment/refund.md) [外链](https://example.com) [资料](raw://sources/a.pdf)",
		"已存 [链接](kb://" + testPageCallback + "#b8Xz) 和 `[代码](/payment/callback.md)`",
		"- [a](<kb://" + testPageIdem + ">)\n- [b](kb://" + testPageIdem + ")",
	}
	for i, block := range got {
		if block.Content != wantContent[i] {
			t.Errorf("block %s content = %q, want %q", block.ID, block.Content, wantContent[i])
		}
		if block.ID != blocks[i].ID {
			t.Errorf("block id changed: %s -> %s", blocks[i].ID, block.ID)
		}
	}

	wantLinks := []Link{
		{FromBlockID: "b1aa", ToPageID: testPageIdem, ToBlockID: "b9Lm", ToPath: "/payment/idempotency"},
		{FromBlockID: "b1aa", ToPageID: testPageCallback, ToPath: "/payment/callback"},
		{FromBlockID: "b2bb", ToPath: "/payment/refund"},
		{FromBlockID: "b3cc", ToPageID: testPageCallback, ToBlockID: "b8Xz", ToPath: "/payment/callback"},
		{FromBlockID: "b4dd", ToPageID: testPageIdem, ToPath: "/payment/idempotency"},
	}
	if !reflect.DeepEqual(links, wantLinks) {
		t.Fatalf("links = %+v\nwant %+v", links, wantLinks)
	}
}

func TestRewriteLinkDestinationsMatchesWholeDestination(t *testing.T) {
	content := "[a](/x.md) [b](/x.md#^b1aa) [c](/x.md)"
	got := RewriteLinkDestinations(content, func(dest string) (string, bool) {
		if dest == "/x.md" {
			return "kb://" + testPageIdem, true
		}

		return "", false
	})

	want := "[a](kb://" + testPageIdem + ") [b](/x.md#^b1aa) [c](kb://" + testPageIdem + ")"
	if got != want {
		t.Fatalf("RewriteLinkDestinations() = %q, want %q", got, want)
	}
}

func TestPageTree(t *testing.T) {
	tree := NewPageTree([]TreeNode{
		{ID: testPagePayment, Slug: "payment"},
		{ID: testPageCallback, ParentID: testPagePayment, Slug: "callback"},
		{ID: "orphan", ParentID: "missing", Slug: "orphan"},
		{ID: "loop-a", ParentID: "loop-b", Slug: "a"},
		{ID: "loop-b", ParentID: "loop-a", Slug: "b"},
	})

	if path, ok := tree.PathByPageID(testPageCallback); !ok || path != "/payment/callback" {
		t.Fatalf("PathByPageID() = %q, %v", path, ok)
	}
	if id, ok := tree.PageIDByPath("payment/callback.md"); !ok || id != testPageCallback {
		t.Fatalf("PageIDByPath() = %q, %v", id, ok)
	}
	for _, id := range []string{"orphan", "loop-a", "loop-b"} {
		if _, ok := tree.PathByPageID(id); ok {
			t.Fatalf("PathByPageID(%q) resolved a broken chain", id)
		}
	}

	tree.Add(TreeNode{ID: "new", ParentID: testPageCallback, Slug: "retry"})
	if id, ok := tree.PageIDByPath("/payment/callback/retry"); !ok || id != "new" {
		t.Fatalf("PageIDByPath() after Add = %q, %v", id, ok)
	}
}

func TestSearchText(t *testing.T) {
	blocks := []Block{
		{ID: "b1aa", Content: "## 去重"},
		{ID: "b2bb", Content: "按**渠道交易号**去重，见[幂等键](kb://" + testPageIdem + ")。\n第二行[^mar-142]"},
		{ID: "b3cc", Content: "- 一\n- 二\n\n  > 引用"},
		{ID: "b4dd", Content: "```sql\nSELECT 1;\n```"},
		{ID: "b5ee", Content: "<div>html</div>"},
		{ID: "b6ff", Content: "<https://example.com>"},
	}

	got := SearchText(" 支付回调 ", blocks)
	want := "支付回调\n去重\n按渠道交易号去重，见幂等键。 第二行[^mar-142]\n一 二 引用\nSELECT 1;\nhttps://example.com"
	if got != want {
		t.Fatalf("SearchText() = %q\nwant %q", got, want)
	}
}
