// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { EMPTY_KB_SEARCH_RESULT, KbSearchResultSchema } from "./kb-schemas";

const hit = {
  page_id: "page-1",
  slug: "team",
  path: "/payment/callback",
  parents: ["产品与业务", "支付"],
  title: "支付回调",
  type: "Workflow",
  block_id: "b8Xz",
  excerpt: "渠道回调按订单号加幂等键去重。",
  score: 0.0325,
  mention: "[支付回调](mention://kb_page/page-1)",
};

const opts = { endpoint: "GET /api/kb/search" };

describe("search schema", () => {
  it("reads a well-formed result", () => {
    const parsed = parseWithFallback({ mode: "hybrid", total: 3, hits: [hit] }, KbSearchResultSchema, EMPTY_KB_SEARCH_RESULT, opts);
    expect(parsed).toEqual({ mode: "hybrid", total: 3, hits: [hit] });
  });

  it("reads an unknown mode as keyword and defaults missing fields", () => {
    const parsed = parseWithFallback(
      { mode: "semantic", hits: [{ page_id: "page-2", parents: ["A", 3], score: "high" }] },
      KbSearchResultSchema,
      EMPTY_KB_SEARCH_RESULT,
      opts,
    );
    expect(parsed.mode).toBe("keyword");
    expect(parsed.total).toBe(0);
    expect(parsed.hits[0]).toMatchObject({ page_id: "page-2", parents: ["A"], score: 0, title: "", block_id: "", excerpt: "" });
  });

  it("drops malformed hits and survives a malformed body", () => {
    const parsed = parseWithFallback({ mode: "keyword", total: 2, hits: [hit, { title: "no id" }, 7] }, KbSearchResultSchema, EMPTY_KB_SEARCH_RESULT, opts);
    expect(parsed.hits.map((h) => h.page_id)).toEqual(["page-1"]);

    expect(parseWithFallback({ error: "boom" }, KbSearchResultSchema, EMPTY_KB_SEARCH_RESULT, opts)).toMatchObject(EMPTY_KB_SEARCH_RESULT);
  });
});
