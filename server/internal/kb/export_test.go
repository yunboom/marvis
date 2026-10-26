package kb

import (
	"bytes"
	"io"
	"sort"
	"testing"
)

// memBundle captures an export in memory, in write order.
type memBundle struct {
	order []string
	files map[string]*bytes.Buffer
}

func (m *memBundle) Create(name string) (io.Writer, error) {
	if m.files == nil {
		m.files = map[string]*bytes.Buffer{}
	}
	buf := &bytes.Buffer{}
	m.files[name] = buf
	m.order = append(m.order, name)

	return buf, nil
}

const (
	exportWorkflowsID = "11111111-1111-4111-8111-111111111111"
	exportCallbackID  = "22222222-2222-4222-8222-222222222222"
	exportRefundID    = "33333333-3333-4333-8333-333333333333"
	exportConceptsID  = "44444444-4444-4444-8444-444444444444"
	exportIdemID      = "55555555-5555-4555-8555-555555555555"
)

func exportFixture() *Export {
	nodes := []ExportNode{
		{ID: exportWorkflowsID, Slug: "workflows", Position: "a0", Title: "流程"},
		{ID: exportCallbackID, ParentID: exportWorkflowsID, Slug: "payment-callback", Position: "a0", Title: "支付回调", Description: "回调怎么处理"},
		{ID: exportRefundID, ParentID: exportWorkflowsID, Slug: "refund", Position: "a1", Title: "退款 (Refund)"},
		{ID: exportConceptsID, Slug: "concepts", Position: "a1", Title: "概念"},
		{ID: exportIdemID, ParentID: exportConceptsID, Slug: "idempotency", Position: "a0", Title: "幂等"},
	}
	linked := []LinkedBlock{
		{PageID: exportIdemID, BlockID: "bH1", Content: "## 去重 键"},
		{PageID: exportIdemID, BlockID: "bP1", Content: "按渠道交易号去重。"},
		{PageID: exportRefundID, BlockID: "bL1", Content: "- 第一步\n- 第二步"},
	}

	return NewExport(ExportMeta{Slug: "team", Name: "团队知识库", Description: "团队的知识", Purpose: "# 目标", Schema: "# Schema\n"}, nodes, linked)
}

func TestExportFrameWritesIndexesPurposeAndSchema(t *testing.T) {
	export := exportFixture()
	out := &memBundle{}
	if err := export.WriteFrame(out); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}

	names := append([]string(nil), out.order...)
	sort.Strings(names)
	want := []string{
		"team/PURPOSE.md",
		"team/SCHEMA.md",
		"team/wiki/concepts/index.md",
		"team/wiki/index.md",
		"team/wiki/workflows/index.md",
	}
	if len(names) != len(want) {
		t.Fatalf("files = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("files = %v, want %v", names, want)
		}
	}

	if got := out.files["team/PURPOSE.md"].String(); got != "# 目标\n" {
		t.Errorf("PURPOSE.md = %q", got)
	}
	wantRoot := "---\nokf_version: 0.2\n---\n\n# 团队知识库\n\n团队的知识\n\n- [流程](workflows.md)\n- [概念](concepts.md)\n"
	if got := out.files["team/wiki/index.md"].String(); got != wantRoot {
		t.Errorf("root index =\n%s\nwant\n%s", got, wantRoot)
	}
	wantWorkflows := "# 流程\n\n- [支付回调](payment-callback.md): 回调怎么处理\n- [退款 (Refund)](refund.md)\n"
	if got := out.files["team/wiki/workflows/index.md"].String(); got != wantWorkflows {
		t.Errorf("workflows index =\n%s\nwant\n%s", got, wantWorkflows)
	}
}

func TestExportPageRewritesLinksAndAddsAnchors(t *testing.T) {
	export := exportFixture()

	callback := ExportPage{
		ID:          exportCallbackID,
		Frontmatter: map[string]any{"title": "支付回调", "type": "workflow", "tags": []any{"支付"}, "description": "回调怎么处理"},
		Blocks: []Block{
			{ID: "b1", Kind: "text", Content: "去重见[幂等](kb://" + exportIdemID + "#bH1)，规则见[这里](kb://" + exportIdemID + "#bP1)。"},
			{ID: "b2", Kind: "text", Content: "退款见[退款](kb://" + exportRefundID + ")，步骤见[列表](kb://" + exportRefundID + "#bL1)。"},
			{ID: "b3", Kind: "text", Content: "还没写：[对账](/payment/reconcile.md#^bX)；规范：[PDF](<raw://sources/渠道 规范.pdf#page=12>)。"},
			{ID: "b4", Kind: "text", Content: "![流程图](raw://assets/flow.png)"},
			{ID: "b5", Kind: "text", Content: "外链 [网站](https://example.com) 不动。"},
		},
		Claims: []Claim{{Key: "c1", BlockID: "b1", Text: "去重", Evidence: []Evidence{{Source: "s1", URI: "task://MAR-1"}}, CheckedAt: "2026-10-01T00:00:00Z"}},
	}
	refund := ExportPage{
		ID:          exportRefundID,
		Frontmatter: map[string]any{"title": "退款 (Refund)", "type": "workflow"},
		Blocks: []Block{
			{ID: "bL1", Kind: "text", Content: "- 第一步\n- 第二步"},
			{ID: "bL2", Kind: "text", Content: "回到[流程](kb://" + exportWorkflowsID + ")"},
		},
	}
	idem := ExportPage{
		ID:          exportIdemID,
		Frontmatter: map[string]any{"title": "幂等", "type": "concept"},
		Blocks: []Block{
			{ID: "bH1", Kind: "text", Content: "## 去重 键"},
			{ID: "bP1", Kind: "text", Content: "按渠道交易号去重。"},
		},
	}

	out := &memBundle{}
	for _, page := range []ExportPage{callback, refund, idem} {
		if err := export.WritePage(out, page); err != nil {
			t.Fatalf("WritePage: %v", err)
		}
	}

	wantCallback := `---
type: workflow
title: 支付回调
description: 回调怎么处理
tags:
    - 支付
marvis_id: 22222222-2222-4222-8222-222222222222
---

去重见[幂等](../concepts/idempotency.md#去重%20键)，规则见[这里](../concepts/idempotency.md#^bP1)。

退款见[退款](refund.md)，步骤见[列表](refund.md#^bL1)。

还没写：[对账](../payment/reconcile.md#^bX)；规范：[PDF](../../raw/sources/渠道%20规范.pdf#page=12)。

![流程图](../../raw/assets/flow.png)

外链 [网站](https://example.com) 不动。
`
	if got := out.files["team/wiki/workflows/payment-callback.md"].String(); got != wantCallback {
		t.Errorf("payment-callback.md =\n%s\nwant\n%s", got, wantCallback)
	}

	wantRefund := `---
type: workflow
title: 退款 (Refund)
marvis_id: 33333333-3333-4333-8333-333333333333
---

- 第一步
- 第二步

^bL1

回到[流程](../workflows.md)
`
	if got := out.files["team/wiki/workflows/refund.md"].String(); got != wantRefund {
		t.Errorf("refund.md =\n%s\nwant\n%s", got, wantRefund)
	}

	wantIdem := `---
type: concept
title: 幂等
marvis_id: 55555555-5555-4555-8555-555555555555
---

## 去重 键

按渠道交易号去重。 ^bP1
`
	if got := out.files["team/wiki/concepts/idempotency.md"].String(); got != wantIdem {
		t.Errorf("idempotency.md =\n%s\nwant\n%s", got, wantIdem)
	}

	claims, ok := out.files["team/wiki/.claims/workflows/payment-callback.json"]
	if !ok {
		t.Fatalf("claims file missing; files = %v", out.order)
	}
	if !bytes.Contains(claims.Bytes(), []byte(`"uri": "task://MAR-1"`)) {
		t.Errorf("claims = %s", claims.String())
	}
	if _, ok := out.files["team/wiki/.claims/workflows/refund.json"]; ok {
		t.Error("a page without claims got a claims file")
	}
	if got := export.RawPath(RawKindSource, "渠道 规范.pdf"); got != "team/raw/sources/渠道 规范.pdf" {
		t.Errorf("RawPath = %q", got)
	}
}

func TestExportIndexPageReplacesGeneratedIndex(t *testing.T) {
	export := NewExport(ExportMeta{Slug: "kb", Name: "KB"}, []ExportNode{
		{ID: exportWorkflowsID, Slug: "index", Position: "a0", Title: "首页"},
	}, nil)
	out := &memBundle{}
	if err := export.WriteFrame(out); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	if _, ok := out.files["kb/wiki/index.md"]; ok {
		t.Error("generated root index written over the index page")
	}
}

func TestRelativePath(t *testing.T) {
	cases := []struct{ from, target, want string }{
		{"", "a.md", "a.md"},
		{"", "a/b.md", "a/b.md"},
		{"a", "a/b.md", "b.md"},
		{"a", "c/d.md", "../c/d.md"},
		{"a/b", "a.md", "../../a.md"},
		{"", "../raw/sources/x.pdf", "../raw/sources/x.pdf"},
		{"a/b", "../raw/sources/x.pdf", "../../../raw/sources/x.pdf"},
	}
	for _, c := range cases {
		if got := relativePath(c.from, c.target); got != c.want {
			t.Errorf("relativePath(%q, %q) = %q, want %q", c.from, c.target, got, c.want)
		}
	}
}

func TestCleanRawName(t *testing.T) {
	for _, bad := range []string{"", "  ", ".", "..", "a/b.pdf", `a\b`, "a#b", "a?b", "a\nb"} {
		if _, ok := CleanRawName(bad); ok {
			t.Errorf("CleanRawName(%q) accepted", bad)
		}
	}
	if got, ok := CleanRawName("  渠道接入规范 v3.pdf "); !ok || got != "渠道接入规范 v3.pdf" {
		t.Errorf("CleanRawName = %q, %v", got, ok)
	}
	if got := RawURI(RawKindAsset, "flow.png"); got != "raw://assets/flow.png" {
		t.Errorf("RawURI = %q", got)
	}
}
