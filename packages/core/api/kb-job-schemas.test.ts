// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_JOB_LIST,
  EMPTY_KB_MERGE_REQUEST_CREATED,
  KbDraftDetailSchema,
  KbJobDetailSchema,
  KbJobListSchema,
  KbMergeRequestCreatedSchema,
  kbDraftDetailFallback,
  kbJobDetailFallback,
} from "./kb-schemas";

const job = {
  id: "job-1",
  knowledge_base_id: "kb-1",
  name: "处理批注",
  starter: "annotations",
  agent_id: "agent-1",
  agent_name: "通用开发助手",
  chat_session_id: "chat-1",
  draft_id: "draft-1",
  created_by: "user-1",
  state: "idle",
  last_reply: "改好了「支付回调」的去重一节。",
  draft: { version: 9, status: "open", pages: 2, added: 3, deleted: 1 },
  merge_request: null,
  annotation_ids: ["a-1"],
  page_id: null,
  created_at: "2026-10-25T10:20:00Z",
  updated_at: "2026-10-25T10:29:00Z",
};

const detail = {
  ...job,
  pages: [
    {
      page_id: "page-1",
      path: "/payment/callback",
      old_path: "",
      title: "支付回调",
      change: "modified",
      added: 1,
      deleted: 1,
      lines: [
        { kind: "context", text: "## 去重", block_id: "b7Kq", old_line: 14, new_line: 14 },
        { kind: "add", text: "按渠道交易号去重。", block_id: "b8Xz", old_line: 0, new_line: 15 },
      ],
    },
  ],
  checks: {
    lint: [{ code: "orphan_page", severity: "warning", page_id: "page-1", path: "/payment/callback", block_id: "", message: "m" }],
    conflicts: [],
  },
};

describe("job schemas", () => {
  it("reads a well-formed list and detail", () => {
    expect(parseWithFallback([job], KbJobListSchema, EMPTY_KB_JOB_LIST, { endpoint: "GET /api/kb/bases/:kb/jobs" })).toEqual([job]);
    expect(parseWithFallback(detail, KbJobDetailSchema, kbJobDetailFallback("job-1"), { endpoint: "GET /api/kb/jobs/:id" })).toEqual(detail);
  });

  it("degrades unknown enums and missing parts to a usable job", () => {
    const parsed = parseWithFallback(
      {
        id: "job-2",
        starter: "revert",
        state: "paused",
        draft_id: "",
        draft: { version: "x", status: "archived" },
        merge_request: { id: "mr-1", number: 16, status: "draft" },
        pages: [{ page_id: "p", change: "renamed", lines: [{ kind: "moved", text: "x" }, { text: 1 }] }, "junk"],
        checks: { lint: [{ severity: "fatal" }] },
      },
      KbJobDetailSchema,
      kbJobDetailFallback("job-2"),
      { endpoint: "GET /api/kb/jobs/:id" },
    );

    expect(parsed.starter).toBe("custom");
    expect(parsed.state).toBe("idle");
    expect(parsed.draft_id).toBeNull();
    expect(parsed.draft).toMatchObject({ version: 0, status: "open", pages: 0 });
    expect(parsed.merge_request).toMatchObject({ number: 16, status: "open", close_reason: "" });
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]).toMatchObject({ change: "modified", lines: [{ kind: "context", text: "x" }] });
    // An unknown severity never blocks submitting.
    expect(parsed.checks.lint[0]?.severity).toBe("warning");
    expect(parsed.checks.conflicts).toEqual([]);
    expect(parsed.annotation_ids).toEqual([]);
  });

  it("falls back on a malformed body", () => {
    expect(parseWithFallback("oops", KbJobDetailSchema, kbJobDetailFallback("job-3"), { endpoint: "GET /api/kb/jobs/:id" })).toMatchObject({
      id: "job-3",
      draft_id: null,
      pages: [],
      checks: { lint: [], conflicts: [] },
    });
    expect(
      parseWithFallback({ number: 3 }, KbMergeRequestCreatedSchema, EMPTY_KB_MERGE_REQUEST_CREATED, {
        endpoint: "POST /api/kb/jobs/:id/submit",
      }),
    ).toEqual(EMPTY_KB_MERGE_REQUEST_CREATED);
  });
});

describe("draft detail schema", () => {
  const endpoint = { endpoint: "GET /api/kb/drafts/:id" };
  const draft = {
    id: "draft-1",
    knowledge_base_id: "kb-1",
    title: "处理批注",
    version: 9,
    status: "open",
    pages: detail.pages,
    checks: detail.checks,
  };

  it("reads a well-formed draft", () => {
    expect(parseWithFallback(draft, KbDraftDetailSchema, kbDraftDetailFallback("draft-1"), endpoint)).toEqual(draft);
  });

  it("degrades unknown enums and missing parts to a usable draft", () => {
    const parsed = parseWithFallback(
      { id: "draft-2", version: "x", status: "archived", pages: [{ page_id: "p", change: "renamed" }, "junk"], checks: null },
      KbDraftDetailSchema,
      kbDraftDetailFallback("draft-2"),
      endpoint,
    );

    expect(parsed).toMatchObject({ id: "draft-2", title: "", version: 0, status: "open", checks: { lint: [], conflicts: [] } });
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]).toMatchObject({ page_id: "p", change: "modified", lines: [] });
  });

  it("falls back on a malformed body", () => {
    expect(parseWithFallback("oops", KbDraftDetailSchema, kbDraftDetailFallback("draft-3"), endpoint)).toEqual(
      kbDraftDetailFallback("draft-3"),
    );
  });
});
