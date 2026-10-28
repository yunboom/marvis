// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  KB_MISSING_PAGE_HREF,
  blockPlainText,
  blockSection,
  citeNumbers,
  citeSourceId,
  compareBlocks,
  inlineDiffMarkdown,
  isFootnoteDefinitionBlock,
  kbPageLink,
  pageHeadings,
  parseKbRoute,
  prepareBlockMarkdown,
} from "./kb-markdown";

const block = (id: string, content: string) => ({ id, kind: "text", content });

describe("prepareBlockMarkdown", () => {
  const numbers = citeNumbers(["mar-142", "spec", "mar-142"]);

  it("numbers sources in first-seen order", () => {
    expect([...numbers]).toEqual([
      ["mar-142", 1],
      ["spec", 2],
    ]);
  });

  it("turns known footnotes into citation links and leaves unknown ones", () => {
    const out = prepareBlockMarkdown("去重。[^mar-142] 签名。[^spec][^ghost]", { citeNumbers: numbers });
    expect(out).toBe("去重。[1](#kb-cite-mar-142) 签名。[2](#kb-cite-spec)[^ghost]");
    expect(citeSourceId("#kb-cite-mar-142")).toBe("mar-142");
    expect(citeSourceId("/kb/x")).toBeNull();
  });

  it("makes links to unwritten pages inert but keeps routed links", () => {
    const out = prepareBlockMarkdown("[退款](/payment/refund.md) [幂等](/kb/team/p/1#b9Lm) [x](/a.md#^b1)", {
      citeNumbers: numbers,
    });
    expect(out).toBe(`[退款](${KB_MISSING_PAGE_HREF}) [幂等](/kb/team/p/1#b9Lm) [x](${KB_MISSING_PAGE_HREF})`);
  });

  it("highlights claim sentences found verbatim", () => {
    const out = prepareBlockMarkdown("渠道回调先验签。支付服务加锁。", {
      citeNumbers: numbers,
      highlights: ["渠道回调先验签。", "不在正文里", ""],
    });
    expect(out).toBe("<mark>渠道回调先验签。</mark>支付服务加锁。");
  });

  it("underlines annotated sentences with the annotations on them", () => {
    const out = prepareBlockMarkdown("渠道回调先验签。支付服务加锁。", {
      citeNumbers: numbers,
      annotations: [
        { quote: "支付服务加锁。", ids: ["a-1", "a-2"] },
        { quote: "不在正文里", ids: ["a-3"] },
        { quote: "渠道回调先验签。", ids: ['x" onclick="y'] },
      ],
    });
    expect(out).toBe('渠道回调先验签。<mark class="kb-annotated" data-annotation-ids="a-1,a-2">支付服务加锁。</mark>');
  });

  // Regression: the quote used to be replaced at its first match in the raw
  // Markdown, so a sentence repeated in an earlier link label (or matching a
  // link destination or citation) put the underline on the link instead.
  it("underlines the annotated occurrence, not a link label or destination that repeats it", () => {
    const content = "见[支付回调](/kb/team/p/page-pay)。支付回调先验签。[^spec]";
    const out = prepareBlockMarkdown(content, {
      citeNumbers: numbers,
      annotations: [{ quote: "支付回调", ids: ["a-1"], prefix: "## 处理顺序\n见支付回调。", suffix: "先验签。 " }],
    });
    expect(out).toBe(
      '见[支付回调](/kb/team/p/page-pay)。<mark class="kb-annotated" data-annotation-ids="a-1">支付回调</mark>先验签。[2](#kb-cite-spec)',
    );

    const inUrl = prepareBlockMarkdown("[退款](/kb/team/p/refund) refund 走原路。", {
      citeNumbers: numbers,
      annotations: [{ quote: "refund", ids: ["a-2"] }],
    });
    expect(inUrl).toBe('[退款](/kb/team/p/refund) <mark class="kb-annotated" data-annotation-ids="a-2">refund</mark> 走原路。');

    const inCite = prepareBlockMarkdown("去重。[^mar-142] 保存 1 天。", {
      citeNumbers: numbers,
      annotations: [{ quote: "1", ids: ["a-3"] }],
    });
    expect(inCite).toBe('去重。[1](#kb-cite-mar-142) 保存 <mark class="kb-annotated" data-annotation-ids="a-3">1</mark> 天。');
  });

  it("marks a sentence inside a link label when that is the annotated one", () => {
    const out = prepareBlockMarkdown("支付回调说明见[支付回调](/kb/team/p/page-pay)。", {
      citeNumbers: numbers,
      annotations: [{ quote: "支付回调", ids: ["a-1"], prefix: "说明见", suffix: "。" }],
    });
    expect(out).toBe('支付回调说明见[<mark class="kb-annotated" data-annotation-ids="a-1">支付回调</mark>](/kb/team/p/page-pay)。');
  });

  it("matches across collapsed whitespace and keeps emphasis whole inside the mark", () => {
    const out = prepareBlockMarkdown("- 回调先验签，\n  再加锁。\n- **重试**三次。\n- 重**试三**次。", {
      citeNumbers: numbers,
      annotations: [
        { quote: "回调先验签， 再加锁。", ids: ["a-1"] },
        { quote: "重试三次", ids: ["a-2"], prefix: "再加锁。 " },
        { quote: "试三", ids: ["a-3"] },
      ],
    });
    expect(out).toBe(
      '- <mark class="kb-annotated" data-annotation-ids="a-1">回调先验签，\n  再加锁。</mark>\n' +
        '- <mark class="kb-annotated" data-annotation-ids="a-2">**重试**三次</mark>。\n' +
        '- 重<mark class="kb-annotated" data-annotation-ids="a-3">**试三**</mark>次。',
    );

    const draft = prepareBlockMarkdown("渠道<del>按订单号</del><ins>按交易号</ins>去重。按订单号查询。", {
      citeNumbers: numbers,
      annotations: [{ quote: "按订单号", ids: ["a-3"] }],
    });
    expect(draft).toBe('渠道<del>按订单号</del><ins>按交易号</ins>去重。<mark class="kb-annotated" data-annotation-ids="a-3">按订单号</mark>查询。');
  });
});

describe("annotations over several list items", () => {
  // Regression: a quote selected across list items crossed the list markers
  // and was left without any underline.
  it("marks each item the quote covers with the same annotation", () => {
    const content = "- 订单折扣和免运费折扣\n- 商品折扣和免运费折扣\n- 商品折扣和订单折扣\n- 其他";
    const out = prepareBlockMarkdown(content, {
      citeNumbers: new Map(),
      annotations: [{ quote: "订单折扣和免运费折扣 商品折扣和免运费折扣 商品折扣和订单折扣", ids: ["a-1"] }],
    });
    const open = '<mark class="kb-annotated" data-annotation-ids="a-1">';
    expect(out).toBe(
      `- ${open}订单折扣和免运费折扣</mark>\n- ${open}商品折扣和免运费折扣</mark>\n- ${open}商品折扣和订单折扣</mark>\n- 其他`,
    );
  });

  it("marks each paragraph and each side of a link edge separately", () => {
    const out = prepareBlockMarkdown("先验签。\n\n再加锁，见[支付回调](/kb/p)说明。", {
      citeNumbers: new Map(),
      annotations: [{ quote: "先验签。 再加锁，见支付回调说明", ids: ["a-2"] }],
    });
    const open = '<mark class="kb-annotated" data-annotation-ids="a-2">';
    expect(out).toBe(`${open}先验签。</mark>\n\n${open}再加锁，见</mark>[${open}支付回调</mark>](/kb/p)${open}说明</mark>。`);
  });
});

describe("block helpers", () => {
  it("detects blocks made only of footnote definitions", () => {
    expect(isFootnoteDefinitionBlock("[^a]: one\n[^b]: two")).toBe(true);
    expect(isFootnoteDefinitionBlock("text [^a]")).toBe(false);
    expect(isFootnoteDefinitionBlock("")).toBe(false);
  });

  it("lists headings with inline markup stripped", () => {
    expect(
      pageHeadings([block("b1", "## 处理 `顺序` ##"), block("b2", "正文"), block("b3", "### [去重](/kb/x)\n下文")]),
    ).toEqual([
      { blockId: "b1", level: 2, text: "处理 顺序" },
      { blockId: "b3", level: 3, text: "去重" },
    ]);
  });
});

describe("block mentions", () => {
  const blocks = [block("h1", "# 支付回调"), block("p1", "导语"), block("h2", "## 去重"), block("p2", "按交易号去重。"), block("p3", "幂等键。")];

  it("names the section a block sits in", () => {
    expect(blockSection(blocks, "h2")).toBe("去重");
    expect(blockSection(blocks, "p3")).toBe("去重");
    expect(blockSection(blocks, "p1")).toBe("支付回调");
    expect(blockSection([block("p0", "无标题")], "p0")).toBe("");
    expect(blockSection(blocks, "gone")).toBe("");
  });

  it("reduces a block to one line of text", () => {
    expect(blockPlainText("## 去重 `键`")).toBe("去重 键");
    expect(blockPlainText("渠道回调按[交易号](/kb/x)去重。[^mar-142]\n- 重复回调返回 **成功**")).toBe(
      "渠道回调按交易号去重。 重复回调返回 成功",
    );
  });
});

describe("compareBlocks", () => {
  it("lines up edits, additions and removals in reading order", () => {
    const published = [block("a", "A"), block("b", "B"), block("c", "C"), block("d", "D")];
    const draft = [block("a", "A"), block("c", "C2"), block("n", "N"), block("d", "D")];

    expect(compareBlocks(published, draft).map((c) => `${c.kind}:${c.block.id}`)).toEqual([
      "same:a",
      "removed:b",
      "changed:c",
      "added:n",
      "same:d",
    ]);
  });

  it("keeps trailing removals", () => {
    expect(compareBlocks([block("a", "A"), block("b", "B")], [block("a", "A")]).map((c) => c.kind)).toEqual([
      "same",
      "removed",
    ]);
  });
});

describe("inlineDiffMarkdown", () => {
  it("marks changed words inline", () => {
    expect(inlineDiffMarkdown("渠道回调按订单号加幂等键去重", "渠道回调按渠道交易号加幂等键去重")).toBe(
      "渠道回调按<del>订单</del><ins>渠道交易</ins>号加幂等键去重",
    );
    expect(inlineDiffMarkdown("retry 8 times", "retry 5 times")).toBe("retry <del>8</del><ins>5</ins> times");
  });

  it("gives up when the edit touches Markdown syntax", () => {
    expect(inlineDiffMarkdown("见幂等键。", "见[幂等键](/kb/x)。")).toBeNull();
    expect(inlineDiffMarkdown("a", "a\nb")).toBeNull();
  });
});

describe("parseKbRoute", () => {
  it("reads slug, page and revision", () => {
    expect(parseKbRoute("/acme/kb/team")).toEqual({ kbSlug: "team", pageId: "", revisionId: "" });
    expect(parseKbRoute("/acme/kb/team/p/p%201")).toEqual({ kbSlug: "team", pageId: "p 1", revisionId: "" });
    expect(parseKbRoute("/acme/kb/team/p/p1/history/r1")).toEqual({
      kbSlug: "team",
      pageId: "p1",
      revisionId: "r1",
    });
    expect(parseKbRoute("/acme/issues/kb")).toEqual({ kbSlug: "", pageId: "", revisionId: "" });
  });
});

describe("kbPageLink", () => {
  it("reads a page link of the knowledge base, with or without the workspace slug", () => {
    expect(kbPageLink("/kb/team/p/page-idem#b9", "team")).toEqual({ pageId: "page-idem", hash: "#b9" });
    expect(kbPageLink("/acme/kb/team/p/p%201?x=1", "team")).toEqual({ pageId: "p 1", hash: "" });
  });

  it("ignores other knowledge bases, other routes and non-app links", () => {
    expect(kbPageLink("/kb/other/p/page-idem", "team")).toBeNull();
    expect(kbPageLink("/acme/kb/team/p/p1/history/r1", "team")).toBeNull();
    expect(kbPageLink("/acme/issues/MAR-1", "team")).toBeNull();
    expect(kbPageLink("#kb-cite-spec", "team")).toBeNull();
    expect(kbPageLink("raw://raw-1", "team")).toBeNull();
    expect(kbPageLink("https://example.com/kb/team/p/p1", "team")).toBeNull();
    expect(kbPageLink("//example.com/kb/team/p/p1", "team")).toBeNull();
    expect(kbPageLink(null, "team")).toBeNull();
  });
});
