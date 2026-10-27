package kb

import (
	"errors"
	"testing"
)

func anchorBlocks(pairs ...string) []Block {
	blocks := make([]Block, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		blocks = append(blocks, Block{ID: pairs[i], Kind: BlockKindText, Content: pairs[i+1]})
	}

	return blocks
}

// annotatedPage is the page an annotation is written on in these tests.
var annotatedPage = anchorBlocks(
	"b1", "## 去重",
	"b2", "渠道回调按**订单号**加幂等键去重。[^mar-142] 幂等键在 Redis 中保存 24 小时。",
	"b3", "重复回调直接返回成功，不再处理。",
)

const annotatedQuote = "渠道回调按订单号加幂等键去重。"

func TestAnchorText(t *testing.T) {
	got := AnchorText("渠道回调按**订单号**加幂等键去重。[^mar-142]\n  幂等键见 [Redis](/infra/redis.md)。")
	if want := "渠道回调按订单号加幂等键去重。 幂等键见 Redis。"; got != want {
		t.Errorf("AnchorText = %q, want %q", got, want)
	}
}

func TestLocateQuote(t *testing.T) {
	anchor, err := LocateQuote(annotatedPage, "b2", "\n  渠道回调按订单号加幂等键去重。 ", "", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}
	if anchor.BlockID != "b2" || anchor.Quote != annotatedQuote {
		t.Fatalf("anchor = %+v", anchor)
	}

	exact, err := LocateQuote(annotatedPage, "b2", annotatedQuote, "", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}
	if exact.Prefix != "去重\n" || exact.Suffix != " 幂等键在 Redis 中保存 24 小时。\n重复回调直接返回成" {
		t.Errorf("context = %q / %q", exact.Prefix, exact.Suffix)
	}

	if _, err := LocateQuote(annotatedPage, "b3", annotatedQuote, "", ""); !errors.Is(err, ErrQuoteNotFound) {
		t.Errorf("quote in another block: err = %v, want ErrQuoteNotFound", err)
	}
	if _, err := LocateQuote(annotatedPage, "b9", annotatedQuote, "", ""); !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("unknown block: err = %v, want ErrBlockNotFound", err)
	}
}

func TestLocateQuoteRepeatUsesHints(t *testing.T) {
	blocks := anchorBlocks("b1", "先对账。然后重试。最后对账。然后告警。")

	anchor, err := LocateQuote(blocks, "b1", "然后", "最后对账。", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}
	if anchor.Prefix != "先对账。然后重试。最后对账。" {
		t.Errorf("prefix = %q, want the second occurrence", anchor.Prefix)
	}
}

func TestRelocate(t *testing.T) {
	original, err := LocateQuote(annotatedPage, "b2", annotatedQuote, "", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}

	cases := []struct {
		name      string
		blocks    []Block
		outcome   AnchorOutcome
		blockID   string
		quote     string
		keepQuote bool
	}{
		{
			name: "sentence still in its block",
			blocks: anchorBlocks(
				"b0", "前言。",
				"b1", "## 去重",
				"b2", "渠道回调按订单号加幂等键去重。幂等键保存 48 小时。",
			),
			outcome: AnchorKept, blockID: "b2", quote: annotatedQuote,
		},
		{
			name: "block split, sentence moved to a new block",
			blocks: anchorBlocks(
				"b1", "## 去重",
				"b2", "幂等键在 Redis 中保存 24 小时。",
				"b7", "渠道回调按订单号加幂等键去重。",
			),
			outcome: AnchorMoved, blockID: "b7", quote: annotatedQuote,
		},
		{
			name: "sentence reworded, found by the context around it",
			blocks: anchorBlocks(
				"b1", "## 去重",
				"b2", "渠道回调改为按渠道交易号去重。 幂等键在 Redis 中保存 24 小时。",
				"b3", "重复回调直接返回成功，不再处理。",
			),
			outcome: AnchorRewritten, blockID: "b2", quote: "渠道回调改为按渠道交易号去重。",
		},
		{
			name: "block replaced with a new id, context still matches",
			blocks: anchorBlocks(
				"b1", "## 去重",
				"b8", "渠道回调按渠道交易号去重。 幂等键在 Redis 中保存 24 小时。",
				"b3", "重复回调直接返回成功，不再处理。",
			),
			outcome: AnchorRewritten, blockID: "b8", quote: "渠道回调按渠道交易号去重。",
		},
		{
			name: "heading removed and sentence reworded, the text after it bounds it",
			blocks: anchorBlocks(
				"b2", "改为按渠道交易号去重。 幂等键在 Redis 中保存 24 小时。",
				"b3", "重复回调直接返回成功，不再处理。",
			),
			outcome: AnchorRewritten, blockID: "b2", quote: "改为按渠道交易号去重。",
		},
		{
			name: "only the sentence's own words survive, lightly edited",
			blocks: anchorBlocks(
				"x1", "# 回调",
				"x2", "渠道回调按订单号和幂等键去重。",
			),
			outcome: AnchorRewritten, blockID: "x2", quote: "渠道回调按订单号和幂等键去重。",
		},
		{
			name: "sentence and its surroundings deleted",
			blocks: anchorBlocks(
				"b1", "## 发布",
				"b9", "灰度比例为 5% → 30% → 100%。",
			),
			outcome: AnchorLost, keepQuote: true,
		},
		{
			name:    "page deleted",
			blocks:  nil,
			outcome: AnchorLost, keepQuote: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, outcome := Relocate(original, tc.blocks)
			if outcome != tc.outcome {
				t.Fatalf("outcome = %d, want %d (anchor %+v)", outcome, tc.outcome, got)
			}
			if tc.keepQuote {
				if got != original {
					t.Errorf("lost anchor = %+v, want it unchanged", got)
				}
				return
			}
			if got.BlockID != tc.blockID || got.Quote != tc.quote {
				t.Errorf("anchor = %q in %s, want %q in %s", got.Quote, got.BlockID, tc.quote, tc.blockID)
			}
			if len([]rune(got.Prefix)) > AnchorContextRunes || len([]rune(got.Suffix)) > AnchorContextRunes {
				t.Errorf("context longer than %d runes: %q / %q", AnchorContextRunes, got.Prefix, got.Suffix)
			}
		})
	}
}

func TestRelocateRepeatedSentencePicksMatchingContext(t *testing.T) {
	blocks := anchorBlocks("b1", "第一步：先对账。", "b2", "第二步：重试三次。", "b3", "第三步：先对账。")
	anchor, err := LocateQuote(blocks, "b3", "先对账。", "", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}

	// b3 is replaced by a new block; the same words are in b1 and b4, and
	// only b4 sits after the remembered context.
	rewritten := anchorBlocks("b1", "第一步：先对账。", "b2", "第二步：重试三次。", "b4", "第三步：先对账。")
	got, outcome := Relocate(anchor, rewritten)
	if outcome != AnchorMoved || got.BlockID != "b4" {
		t.Errorf("relocated to %s (%d), want b4 moved", got.BlockID, outcome)
	}
}

func TestApproxFind(t *testing.T) {
	text := []rune("abcdefgh-hello world-xyz")
	m, ok := approxFind(text, []rune("helo world"), 0, len(text))
	if !ok || m.dist != 1 || string(text[m.start:m.end]) != "hello world" {
		t.Errorf("match = %+v (%q), want hello world at distance 1", m, string(text[m.start:m.end]))
	}

	if _, ok := approxFind(text, []rune("abc"), 5, 5); ok {
		t.Error("empty window matched")
	}
}

func TestRelocateShortQuoteDoesNotJump(t *testing.T) {
	anchor, err := LocateQuote(annotatedPage, "b1", "去重", "", "")
	if err != nil {
		t.Fatalf("LocateQuote: %v", err)
	}

	// The heading is deleted; "去重" still occurs inside an unrelated sentence.
	rewritten := anchorBlocks("b5", "退款按交易号去重后原路返回。")
	if got, outcome := Relocate(anchor, rewritten); outcome != AnchorLost {
		t.Errorf("relocated to %q in %s (%d), want lost", got.Quote, got.BlockID, outcome)
	}
}
