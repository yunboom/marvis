// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KNOWLEDGE_BASE_DETAIL,
  EMPTY_KNOWLEDGE_BASE_LIST,
  KnowledgeBaseDetailSchema,
  KnowledgeBaseListSchema,
} from "./kb-schemas";
import { countOpenMergeRequests } from "../kb/queries";
import type { KnowledgeBase, KnowledgeBaseDetail } from "../types/kb";

const base = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "Team",
  slug: "team",
  description: "Shared knowledge",
  schema_mode: "default",
  created_by: "user-1",
  page_count: 23,
  content_version: 7,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
  pending: { annotations: 3, stale_pages: 2, open_mrs: 1 },
};

function parseList(raw: unknown): KnowledgeBase[] {
  return parseWithFallback(raw, KnowledgeBaseListSchema, EMPTY_KNOWLEDGE_BASE_LIST, {
    endpoint: "GET /api/kb/bases",
  });
}

function parseDetail(raw: unknown): KnowledgeBaseDetail {
  return parseWithFallback(raw, KnowledgeBaseDetailSchema, EMPTY_KNOWLEDGE_BASE_DETAIL, {
    endpoint: "GET /api/kb/bases/:kb",
  });
}

describe("knowledge base list schema", () => {
  it("parses a well-formed list", () => {
    expect(parseList([base])).toEqual([base]);
  });

  it("keeps unknown schema modes instead of failing", () => {
    expect(parseList([{ ...base, schema_mode: "future-mode" }])[0]?.schema_mode).toBe(
      "future-mode",
    );
  });

  it("defaults missing optional fields and counters", () => {
    const [parsed] = parseList([
      { id: "kb-2", name: "Bare", slug: "bare", description: null },
    ]);
    expect(parsed).toMatchObject({
      description: "",
      schema_mode: "default",
      created_by: "",
      page_count: 0,
      content_version: 0,
      pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
    });
  });

  it("degrades malformed pending counts to zero", () => {
    const [parsed] = parseList([
      { ...base, pending: { annotations: "3", stale_pages: null } },
    ]);
    expect(parsed?.pending).toEqual({ annotations: 0, stale_pages: 0, open_mrs: 0 });
    expect(parseList([{ ...base, pending: "oops" }])[0]?.pending.open_mrs).toBe(0);
  });

  it("falls back to an empty list for a malformed response", () => {
    expect(parseList({ bases: [] })).toEqual([]);
    expect(parseList([{ ...base, id: 42 }])).toEqual([]);
  });
});

describe("knowledge base detail schema", () => {
  it("parses purpose and schema text", () => {
    const parsed = parseDetail({ ...base, purpose: "Why", schema: "# Schema" });
    expect(parsed.purpose).toBe("Why");
    expect(parsed.schema).toBe("# Schema");
    expect(parsed.pending.annotations).toBe(3);
  });

  it("defaults missing purpose and schema", () => {
    const parsed = parseDetail(base);
    expect(parsed.purpose).toBe("");
    expect(parsed.schema).toBe("");
  });

  it("falls back to the empty detail for a malformed response", () => {
    expect(parseDetail(null)).toEqual(EMPTY_KNOWLEDGE_BASE_DETAIL);
  });
});

describe("countOpenMergeRequests", () => {
  it("sums open merge requests across bases", () => {
    const [a] = parseList([base]);
    const [b] = parseList([{ ...base, id: "kb-2", pending: { open_mrs: 4 } }]);
    expect(countOpenMergeRequests([a!, b!])).toBe(5);
    expect(countOpenMergeRequests([])).toBe(0);
  });
});
