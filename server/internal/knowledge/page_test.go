package knowledge

import (
	"context"
	"reflect"
	"testing"
	"time"
)

const samplePage = `---
type: entity
title: 支付服务
domains: [dev, product]
verified: {by: 王芳, at: 2026-10-20}
stale_after: 2026-01-01
---

# 支付服务

## 职责

支付服务负责创建支付单。[^1] Refunds go through the refund service.[^1]

## 回调处理

渠道回调按订单号去重，重复回调直接返回成功。[^2]
见 [订单服务](order-service.md) 和 [退款规则](../concepts/refund-rules.md#规则)。

- 验签失败时记录告警。

` + "```" + `
not a sentence。
` + "```" + `

[^1]: task://MAR-128 支付回调重构
[^2]: repo://order-api/internal/pay/callback.go#L40-L82@3f2a91c
`

func TestParsePageReadsFrontMatterSectionsAndFootnotes(t *testing.T) {
	p := ParsePage("team/wiki/entities/payment-service.md", []byte(samplePage))

	if p.Title != "支付服务" || p.FrontMatter.Type != "entity" || !reflect.DeepEqual(p.FrontMatter.Domains, []string{"dev", "product"}) {
		t.Fatalf("front matter = %+v title=%q", p.FrontMatter, p.Title)
	}
	if p.FrontMatter.Verified == nil || p.FrontMatter.Verified.By != "王芳" {
		t.Fatalf("verified = %+v", p.FrontMatter.Verified)
	}
	if !p.FrontMatter.IsStale(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("page past stale_after should be stale")
	}
	if len(p.Sections) != 2 || p.Sections[0].Heading != "职责" || p.Sections[1].Heading != "回调处理" {
		t.Fatalf("sections = %+v", p.Sections)
	}
	first := p.Sections[0].Paragraphs[0]
	if len(first) != 2 || first[0].Text != "支付服务负责创建支付单。" || !reflect.DeepEqual(first[0].Cites, []int{1}) {
		t.Fatalf("first paragraph = %+v", first)
	}
	if first[1].Text != "Refunds go through the refund service." {
		t.Fatalf("english sentence = %q", first[1].Text)
	}
	if len(p.Footnotes) != 2 || p.Footnotes[0].Kind != SourceTask || p.Footnotes[0].Label != "支付回调重构" || p.Footnotes[1].Kind != SourceRepo {
		t.Fatalf("footnotes = %+v", p.Footnotes)
	}
	want := []string{"team/wiki/entities/order-service.md", "team/wiki/concepts/refund-rules.md"}
	if !reflect.DeepEqual(p.Links, want) {
		t.Fatalf("links = %v, want %v", p.Links, want)
	}
	for _, sec := range p.Sections {
		for _, para := range sec.Paragraphs {
			for _, s := range para {
				if s.Text == "not a sentence。" {
					t.Fatalf("code fence content parsed as a sentence")
				}
			}
		}
	}
}

func TestParsePageWithoutFrontMatterFallsBackToFileName(t *testing.T) {
	p := ParsePage("team/wiki/howtos/release.md", []byte("plain text."))
	if p.Title != "release" || p.HasFrontMatter {
		t.Fatalf("page = %+v", p)
	}
}

func TestSplitSentences(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"第一句。第二句！第三句？", []string{"第一句。", "第二句！", "第三句？"}},
		{"Version 1.2 is out. Next one soon", []string{"Version 1.2 is out.", "Next one soon"}},
		{"结论。[^3][^4] 后续", []string{"结论。", "后续"}},
		{"", nil},
	}
	for _, c := range cases {
		var got []string
		for _, s := range SplitSentences(c.in) {
			got = append(got, s.Text)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitSentences(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	if s := SplitSentences("结论。[^3][^4]"); len(s) != 1 || !reflect.DeepEqual(s[0].Cites, []int{3, 4}) {
		t.Errorf("trailing footnotes = %+v", s)
	}
}

func TestTokenizeMixesBigramsAndWords(t *testing.T) {
	got := Tokenize("支付回调 Callback v2")
	want := []string{"支付", "付回", "回调", "callback", "v2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %v, want %v", got, want)
	}
}

func TestCorpusSearchBacklinksAndGraph(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	commit := mustCommit(t, s, MainRef, head, head,
		FileChange{Path: "team/wiki/entities/payment-service.md", Content: []byte(samplePage)},
		FileChange{Path: "team/wiki/entities/order-service.md", Content: []byte("---\ntitle: 订单服务\n---\n订单服务管理下单。见 [支付](payment-service.md)。\n")},
		FileChange{Path: "team/wiki/concepts/refund-rules.md", Content: []byte("---\ntitle: 退款规则\n---\n退款 T+1 到账。\n")},
		FileChange{Path: "pay/wiki/concepts/idempotency.md", Content: []byte("---\ntitle: 幂等设计\n---\n写接口要求幂等键。\n")},
		FileChange{Path: "team/index.md", Content: []byte("# index\n")},
	)

	c, err := s.LoadCorpus(ctx, testWorkspace, commit)
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	if len(c.Pages) != 4 || !c.Others["team/index.md"] {
		t.Fatalf("pages=%d others=%v", len(c.Pages), c.Others)
	}
	if again, _ := s.LoadCorpus(ctx, testWorkspace, commit); again != c {
		t.Fatalf("corpus not cached by commit")
	}

	hits := c.Search("支付回调", "", 5)
	if len(hits) == 0 || hits[0].Path != "team/wiki/entities/payment-service.md" {
		t.Fatalf("search hits = %+v", hits)
	}
	if hits := c.Search("幂等", "team", 5); len(hits) != 0 {
		t.Fatalf("slug filter leaked: %+v", hits)
	}
	if hits := c.Search("完全无关的词语", "", 5); len(hits) != 0 {
		t.Fatalf("unexpected hits: %+v", hits)
	}

	if bl := c.Backlinks("team/wiki/entities/payment-service.md"); !reflect.DeepEqual(bl, []string{"team/wiki/entities/order-service.md"}) {
		t.Fatalf("backlinks = %v", bl)
	}
	if edges := c.Graph("team"); len(edges) != 3 {
		t.Fatalf("graph edges = %+v", edges)
	}
	if ClaimsPath("team/wiki/entities/payment-service.md") != "team/.claims/wiki/entities/payment-service.md.json" {
		t.Fatalf("claims path = %s", ClaimsPath("team/wiki/entities/payment-service.md"))
	}
}
