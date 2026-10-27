// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_MERGE_REQUEST_LIST,
  EMPTY_KB_MR_COMMENT_LIST,
  KbMergeRequestDetailSchema,
  KbMergeRequestListSchema,
  KbMrCommentListSchema,
  KbMrCommentSchema,
  KbMrReviewListSchema,
  KbMrTimelineSchema,
  EMPTY_KB_MR_REVIEW_LIST,
  EMPTY_KB_MR_TIMELINE,
  kbMergeRequestDetailFallback,
  kbMrCommentFallback,
} from "./kb-schemas";

const mr = {
  id: "mr-1",
  number: 16,
  knowledge_base_id: "kb-1",
  title: "去重键改为渠道交易号",
  summary: "处理批注 a1b2c3d4。",
  source: "annotations",
  status: "open",
  risk: "medium",
  author_type: "agent",
  author_id: "agent-1",
  author_name: "通用开发助手",
  draft_id: "draft-1",
  draft_version: 9,
  annotation_ids: ["a-1"],
  origin: { type: "kb_job", label: "处理批注", ref_id: "job-1", openable: true },
  job_id: "job-1",
  reverts: null,
  merged_by: null,
  merged_by_name: "",
  merged_at: null,
  closed_by: null,
  closed_by_name: "",
  closed_at: null,
  close_reason: "",
  review_requested_at: null,
  created_at: "2026-10-25T10:31:00Z",
  updated_at: "2026-10-25T10:41:00Z",
  mention: "[#16 去重键改为渠道交易号](mention://kb_mr/mr-1)",
};

const detail = {
  ...mr,
  knowledge_base_slug: "team",
  knowledge_base_name: "团队知识库",
  pages: [
    {
      page_id: "page-1",
      path: "/payment/callback",
      old_path: "",
      title: "支付回调",
      change: "modified",
      added: 1,
      deleted: 1,
      lines: [{ kind: "delete", text: "按订单号去重。", block_id: "b8Xz", old_line: 15, new_line: 0 }],
    },
  ],
  checks: {
    lint: [],
    conflicts: [{ page_id: "page-1", path: "/payment/callback", kind: "block", block_id: "b8Xz", main_lines: "15-15", draft_lines: "15-16" }],
  },
  agent_running: false,
  owner_id: "user-2",
  owner_name: "李雷",
  reviews: [
    {
      id: "rv-1",
      merge_request_id: "mr-1",
      reviewer_id: "user-1",
      reviewer_name: "王芳",
      state: "submitted",
      summary: "两处要改。",
      comment_count: 2,
      created_at: "2026-10-25T10:35:00Z",
      submitted_at: "2026-10-25T10:38:00Z",
    },
  ],
  pending_review: null,
  can_merge: true,
  can_close: true,
  can_revert: true,
  can_review: true,
  can_request_review: false,
};

const comment = {
  id: "c-1",
  merge_request_id: "mr-1",
  parent_id: null,
  quote: { page_id: "page-1", block_id: "b8Xz", text: "按渠道交易号去重。" },
  body: "补一下原因。",
  author_type: "member",
  author_id: "user-1",
  author_name: "王芳",
  review_id: "rv-1",
  state: "published",
  created_at: "2026-10-25T10:38:00Z",
};

describe("review schemas", () => {
  it("reads well-formed merge requests, a detail and comments", () => {
    expect(parseWithFallback([mr], KbMergeRequestListSchema, EMPTY_KB_MERGE_REQUEST_LIST, { endpoint: "GET /api/kb/merge-requests" })).toEqual([mr]);
    expect(
      parseWithFallback(detail, KbMergeRequestDetailSchema, kbMergeRequestDetailFallback(), { endpoint: "GET /api/kb/merge-requests/:number" }),
    ).toEqual(detail);
    expect(parseWithFallback([comment], KbMrCommentListSchema, EMPTY_KB_MR_COMMENT_LIST, { endpoint: "GET comments" })).toEqual([comment]);
  });

  it("degrades unknown or missing fields instead of failing", () => {
    const parsed = parseWithFallback(
      {
        ...detail,
        status: "archived",
        reviews: [{ summary: "no id" }, detail.reviews[0]],
        pending_review: "x",
        origin: { type: "something_new", label: "x" },
        reverts: "15",
        draft_version: "9",
        can_merge: "yes",
        checks: null,
        pages: [{ title: "no id" }, detail.pages[0]],
      },
      KbMergeRequestDetailSchema,
      kbMergeRequestDetailFallback(),
      { endpoint: "GET /api/kb/merge-requests/:number" },
    );

    expect(parsed.status).toBe("open");
    expect(parsed.origin).toEqual({ type: "none", label: "x", ref_id: null, openable: true });
    expect(parsed.reverts).toBeNull();
    expect(parsed.draft_version).toBe(0);
    expect(parsed.can_merge).toBe(false);
    expect(parsed.checks).toEqual({ lint: [], conflicts: [] });
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.reviews).toEqual(detail.reviews);
    expect(parsed.pending_review).toBeNull();
  });

  it("reads a detail from a server before reviews", () => {
    const { owner_id: _o, owner_name: _n, reviews: _r, pending_review: _p, can_review: _c, can_request_review: _q, ...old } = detail;
    const parsed = parseWithFallback({ ...old, review_agent: { id: "agent-1", name: "x" } }, KbMergeRequestDetailSchema, kbMergeRequestDetailFallback(), {
      endpoint: "GET /api/kb/merge-requests/:number",
    });

    expect(parsed).toMatchObject({ reviews: [], pending_review: null, can_review: false, can_request_review: false, owner_id: "" });
    expect(parsed.status).toBe("open");
    const { review_id: _id, state: _state, ...oldComment } = comment;
    expect(parseWithFallback({ ...oldComment, triggered: [] }, KbMrCommentSchema, kbMrCommentFallback(), { endpoint: "GET comments" })).toMatchObject({
      review_id: null,
      state: "published",
    });
  });

  it("reads reviews and the timeline, dropping what it cannot place", () => {
    expect(parseWithFallback([{ state: "pending" }, { ...detail.reviews[0], state: "later" }], KbMrReviewListSchema, EMPTY_KB_MR_REVIEW_LIST, { endpoint: "GET reviews" })).toEqual([
      detail.reviews[0],
    ]);

    const timeline = parseWithFallback(
      [
        { type: "event", id: "e-1", kind: "review_submitted", actor_type: "member", actor_id: "user-1", actor_name: "王芳", payload: { review_id: "rv-1", comment_count: 2 }, created_at: "t1" },
        { type: "comment", ...comment },
        { type: "event", id: "e-2", kind: "labelled", actor_type: "member", actor_id: "u", actor_name: "", payload: null, created_at: "t3" },
        { type: "reaction", id: "x-1", created_at: "t4" },
        { type: "comment", created_at: "t5" },
      ],
      KbMrTimelineSchema,
      EMPTY_KB_MR_TIMELINE,
      { endpoint: "GET timeline" },
    );

    expect(timeline.map((e) => e.id)).toEqual(["e-1", "c-1", "e-2"]);
    expect(timeline[1]).toEqual({ type: "comment", ...comment });
    expect(timeline[2]).toMatchObject({ type: "event", kind: "unknown", payload: {} });
    expect(parseWithFallback({ broken: true }, KbMrTimelineSchema, EMPTY_KB_MR_TIMELINE, { endpoint: "GET timeline" })).toEqual([]);
  });

  it("drops malformed list entries and falls back on a broken body", () => {
    expect(
      parseWithFallback([{ number: 3 }, mr], KbMergeRequestListSchema, EMPTY_KB_MERGE_REQUEST_LIST, { endpoint: "GET /api/kb/merge-requests" }),
    ).toEqual([mr]);
    expect(parseWithFallback("oops", KbMergeRequestDetailSchema, kbMergeRequestDetailFallback(), { endpoint: "GET mr" })).toMatchObject({
      can_merge: false,
      can_close: false,
      pages: [],
    });
    expect(parseWithFallback({ ...comment, state: "draft", quote: "x" }, KbMrCommentSchema, kbMrCommentFallback(), { endpoint: "POST comments" })).toMatchObject({
      state: "published",
      quote: null,
    });
  });
});
