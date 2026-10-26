// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_ANNOTATION_LIST,
  KbAnnotationListSchema,
  KbAnnotationSchema,
  kbAnnotationFallback,
} from "./kb-schemas";

const annotation = {
  id: "a-1",
  knowledge_base_id: "kb-1",
  page_id: "page-1",
  page_path: "/payment/callback",
  page_title: "支付回调",
  block_id: "b8Xz",
  block_index: 2,
  quote: "渠道回调按订单号加幂等键去重。",
  original_quote: "",
  prefix: "去重\n",
  suffix: "幂等键在 Redis 中保存 24 小时",
  body: "去重键已经改成渠道交易号。",
  author_type: "member",
  author_id: "user-1",
  author_name: "王芳",
  status: "processing",
  anchor_lost: false,
  merge_request_id: "mr-1",
  mr_number: 16,
  created_at: "2026-10-24T17:40:00Z",
  updated_at: "2026-10-24T17:40:00Z",
  mention: "[批注 · 支付回调](mention://kb_annotation/a-1)",
};

const opts = { endpoint: "GET /api/kb/bases/:kb/annotations" };

describe("annotation schemas", () => {
  it("reads a well-formed list", () => {
    const list = parseWithFallback([annotation], KbAnnotationListSchema, EMPTY_KB_ANNOTATION_LIST, opts);
    expect(list).toEqual([annotation]);
  });

  it("defaults missing fields and unknown enums", () => {
    const parsed = parseWithFallback(
      { id: "a-2", status: "archived", author_type: "robot", page_id: "", mr_number: "x", anchor_lost: "yes" },
      KbAnnotationSchema,
      kbAnnotationFallback("a-2"),
      opts,
    );
    expect(parsed).toMatchObject({
      id: "a-2",
      status: "pending",
      author_type: "member",
      page_id: null,
      merge_request_id: null,
      mr_number: null,
      anchor_lost: false,
      quote: "",
      block_index: 0,
    });
  });

  it("drops malformed entries and survives a malformed body", () => {
    const list = parseWithFallback([annotation, { body: "no id" }, 7], KbAnnotationListSchema, EMPTY_KB_ANNOTATION_LIST, opts);
    expect(list.map((a) => a.id)).toEqual(["a-1"]);

    expect(parseWithFallback({ error: "boom" }, KbAnnotationListSchema, EMPTY_KB_ANNOTATION_LIST, opts)).toEqual([]);
    expect(parseWithFallback(null, KbAnnotationSchema, kbAnnotationFallback("a-3"), opts).id).toBe("a-3");
  });
});
