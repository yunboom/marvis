package kb

import "testing"

func TestRawLinksRewriteKnownFiles(t *testing.T) {
	blocks := []Block{
		{ID: "b1", Content: "见[规范](raw://sources/spec.pdf#page=3)和[缺失](raw://sources/gone.pdf)。"},
		{ID: "b2", Content: "![图](raw://assets/flow.png) 再引用 [规范](raw://sources/spec.pdf#page=3)"},
	}

	refs := RawRefsInBlocks(blocks)
	if len(refs) != 3 || refs[0].Name != "spec.pdf" || refs[2].Kind != RawKindAsset {
		t.Fatalf("refs = %+v", refs)
	}

	out := RawLinks(blocks, map[string]string{
		RawFileKey(RawKindSource, "spec.pdf"): "r1",
		RawFileKey(RawKindAsset, "flow.png"):  "r2",
	})
	if want := "见[规范](/api/kb/raw/r1/content#page=3)和[缺失](raw://sources/gone.pdf)。"; out[0].Content != want {
		t.Errorf("block 1 = %q, want %q", out[0].Content, want)
	}
	if want := "![图](/api/kb/raw/r2/content) 再引用 [规范](/api/kb/raw/r1/content#page=3)"; out[1].Content != want {
		t.Errorf("block 2 = %q, want %q", out[1].Content, want)
	}
	if blocks[0].Content == out[0].Content {
		t.Error("RawLinks modified its input")
	}
}
