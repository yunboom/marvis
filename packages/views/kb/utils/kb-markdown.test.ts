// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  KB_MISSING_PAGE_HREF,
  citeNumbers,
  citeSourceId,
  compareBlocks,
  inlineDiffMarkdown,
  isFootnoteDefinitionBlock,
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
