// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_HOME,
  EMPTY_KB_PAGE,
  EMPTY_KB_REVISION_DIFF,
  EMPTY_KB_REVISION_LIST,
  EMPTY_KB_TREE_LEVEL,
  KbHomeSchema,
  KbPageSchema,
  KbRevisionDiffSchema,
  KbRevisionListSchema,
  KbTreeLevelSchema,
} from "./kb-schemas";
import type { KbHome, KbPage, KbRevision, KbRevisionDiff, KbTreeLevel } from "../types/kb";

const page = {
  id: "page-1",
  knowledge_base_id: "kb-1",
  path: "/payment/callback",
  version: "rev-1",
  breadcrumb: [{ id: "page-0", title: "支付" }],
  frontmatter: { type: "Workflow", title: "支付回调", tags: ["dev"] },
  blocks: [{ id: "b8Xz", kind: "text", content: "按渠道交易号去重。[^mar-142]" }],
  sources: [
    {
      id: "spec",
      kind: "raw",
      uri: "raw://sources/a.pdf#page=12",
      title: "规范",
      version: "",
      openable: true,
      raw: {
        id: "raw-1",
        name: "a.pdf",
        content_type: "application/pdf",
        size: 10,
        uploaded_by: "user-1",
        created_at: "2026-10-08T00:00:00Z",
        page: 12,
      },
    },
  ],
  claims: [{ key: "c1", block_id: "b8Xz", text: "按渠道交易号去重。", checked_at: "2026-10-25T00:00:00Z" }],
  last_mr: { number: 15, author_type: "agent", author_id: "a-1", author_name: "助手", merged_at: "2026-10-25T00:00:00Z" },
  updated_at: "2026-10-25T00:00:00Z",
  stale: true,
  backlinks: [{ id: "page-2", title: "幂等键" }],
  pending_mr: { number: 16, title: "去重键" },
  pending_mr_count: 1,
  annotations_open: 2,
  draft_change: "",
  drafts: [
    {
      id: "d-1",
      title: "",
      status: "open",
      updated_at: "2026-10-25T00:00:00Z",
      draft_change: "modified",
      changed_blocks: 1,
      origin: { type: "chat", label: "回调去重键", ref_id: "s-1" },
    },
  ],
};

function parsePage(raw: unknown): KbPage {
  return parseWithFallback(raw, KbPageSchema, EMPTY_KB_PAGE, { endpoint: "GET /api/kb/pages/:id" });
}

describe("knowledge base page schema", () => {
  it("parses a well-formed page", () => {
    expect(parsePage(page)).toEqual(page);
  });

  it("defaults missing collections and nullable objects", () => {
    const parsed = parsePage({ id: "page-1" });
    expect(parsed).toMatchObject({
      breadcrumb: [],
      frontmatter: {},
      blocks: [],
      sources: [],
      last_mr: null,
      pending_mr: null,
      drafts: [],
      stale: false,
      annotations_open: 0,
    });
  });

  it("drops malformed entries instead of failing the page", () => {
    const parsed = parsePage({
      ...page,
      blocks: [{ id: "ok", content: "x" }, { content: "no id" }, 3],
      sources: [{ id: "s", kind: 7, raw: "bad" }],
      last_mr: "oops",
    });
    expect(parsed.blocks).toEqual([{ id: "ok", kind: "text", content: "x" }]);
    expect(parsed.sources[0]).toMatchObject({ id: "s", kind: "other", raw: null, openable: false });
    expect(parsed.last_mr).toBeNull();
  });

  it("falls back to the empty page for a malformed response", () => {
    expect(parsePage("nope")).toEqual(EMPTY_KB_PAGE);
  });
});

describe("knowledge base tree level schema", () => {
  const parse = (raw: unknown): KbTreeLevel =>
    parseWithFallback(raw, KbTreeLevelSchema, EMPTY_KB_TREE_LEVEL, { endpoint: "GET /api/kb/bases/:kb/pages" });

  it("parses pages and the cursor", () => {
    const parsed = parse({
      version: 87,
      parent: { id: "p", path: "/payment", title: "支付" },
      pages: [{ id: "c", path: "/payment/callback", title: "支付回调", has_child: true, child_count: 2, draft_change: "added" }],
      next_cursor: "abc",
      total: 7,
    });
    expect(parsed.total).toBe(7);
    expect(parsed.parent?.title).toBe("支付");
    expect(parsed.pages[0]).toMatchObject({ has_child: true, child_count: 2, draft_change: "added", stale: false });
    expect(parsed.next_cursor).toBe("abc");
  });

  it("treats a missing cursor and parent as a complete top level", () => {
    const parsed = parse({ pages: [] });
    expect(parsed.parent).toBeNull();
    expect(parsed.next_cursor).toBe("");
    expect(parsed.total).toBe(0);
  });

  it("defaults a malformed total to 0", () => {
    expect(parse({ pages: [], total: "many" }).total).toBe(0);
  });

  it("falls back for a malformed response", () => {
    expect(parse(null)).toEqual(EMPTY_KB_TREE_LEVEL);
  });
});

describe("knowledge base home schema", () => {
  const parse = (raw: unknown): KbHome =>
    parseWithFallback(raw, KbHomeSchema, EMPTY_KB_HOME, { endpoint: "GET /api/kb/bases/:kb/home" });

  it("parses the home overview", () => {
    const parsed = parse({
      knowledge_base: { id: "kb-1", name: "团队知识库", slug: "team" },
      pending: { annotations: 4, agent_reported: 1, stale_pages: 2, open_mrs: 1, latest_mr: { number: 16, title: "t" } },
      recent: [{ page_id: "p", path: "/a", title: "A", mr_number: 15, mr_title: "m", merged_at: "x" }],
      running_jobs: 1,
    });
    expect(parsed.pending.latest_mr?.number).toBe(16);
    expect(parsed.recent).toHaveLength(1);
    expect(parsed.knowledge_base.pending.open_mrs).toBe(0);
  });

  it("defaults pending work", () => {
    const parsed = parse({ knowledge_base: { id: "kb-1", name: "n", slug: "s" }, pending: "bad" });
    expect(parsed.pending).toEqual(EMPTY_KB_HOME.pending);
    expect(parsed.recent).toEqual([]);
  });

  it("falls back when the knowledge base is missing", () => {
    expect(parse({})).toEqual(EMPTY_KB_HOME);
  });
});

describe("knowledge base history schemas", () => {
  const revision = {
    revision_id: "r-1",
    mr_number: 9,
    mr_title: "处理批注",
    source: "annotations",
    author_type: "agent",
    author_id: "a",
    author_name: "助手",
    merged_by: "u",
    merged_by_name: "王芳",
    merged_at: "2026-10-19T00:00:00Z",
    annotations: 1,
    added: 1,
    deleted: 1,
    current: true,
  };

  it("parses the history list and keeps the initial revision's null number", () => {
    const parsed = parseWithFallback(
      [revision, { revision_id: "r-0", mr_number: null }],
      KbRevisionListSchema,
      EMPTY_KB_REVISION_LIST,
      { endpoint: "GET /api/kb/pages/:id/history" },
    ) as KbRevision[];
    expect(parsed[0]).toEqual(revision);
    expect(parsed[1]).toMatchObject({ mr_number: null, added: 0, current: false });
  });

  it("parses a diff and falls back for a malformed one", () => {
    const parse = (raw: unknown): KbRevisionDiff =>
      parseWithFallback(raw, KbRevisionDiffSchema, EMPTY_KB_REVISION_DIFF, {
        endpoint: "GET /api/kb/pages/:id/history/:revision",
      });
    const parsed = parse({
      revision,
      prev_revision_id: "r-0",
      hunks: [{ heading: "处理顺序", lines: [{ op: "added", new_line: 10, text: "x" }] }],
    });
    expect(parsed.hunks[0]?.lines[0]).toEqual({ op: "added", old_line: 0, new_line: 10, text: "x" });
    expect(parse(undefined)).toEqual(EMPTY_KB_REVISION_DIFF);
  });
});
