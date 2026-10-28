import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import { paths } from "@marvis/core/paths";
import type {
  KbMergeRequest,
  KbMergeRequestDetail,
  KbMrComment,
  KbMrReview,
  KbMrTimelineEntry,
  KnowledgeBaseDetail,
} from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbChangesPage } from "./kb-changes-page";
import { KbReviewPage } from "./kb-review-page";
import { kbOriginHref, parseKbReviewRoute } from "./kb-review-route";

vi.mock("@marvis/core/api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly statusText = "",
      readonly body?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      getKnowledgeBase: vi.fn(),
      listKnowledgeBaseMergeRequests: vi.fn(),
      getKnowledgeBaseMergeRequest: vi.fn(),
      listKnowledgeBaseMrComments: vi.fn(),
      listKnowledgeBaseMrTimeline: vi.fn(),
      createKnowledgeBaseMrComment: vi.fn(),
      updateKnowledgeBaseMrComment: vi.fn(),
      deleteKnowledgeBaseMrComment: vi.fn(),
      openKnowledgeBaseMrReview: vi.fn(),
      submitKnowledgeBaseMrReview: vi.fn(),
      discardKnowledgeBaseMrReview: vi.fn(),
      requestKnowledgeBaseMrReview: vi.fn(),
      mergeKnowledgeBaseMergeRequest: vi.fn(),
      closeKnowledgeBaseMergeRequest: vi.fn(),
      revertKnowledgeBaseMergeRequest: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// The viewer is user-3: a reviewer, not the owner (user-1) unless a test says so.
const auth = vi.hoisted(() => ({ state: { user: { id: "user-3" } } }));
vi.mock("@marvis/core/auth", () => {
  const useAuthStore = Object.assign(
    (selector?: (s: typeof auth.state) => unknown) => (selector ? selector(auth.state) : auth.state),
    { getState: () => auth.state },
  );
  return { useAuthStore };
});

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="avatar">{actorId}</span>,
}));

const mocked = vi.mocked(api);

const BASE: KnowledgeBaseDetail = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "团队知识库",
  slug: "team",
  description: "",
  schema_mode: "default",
  created_by: "user-2",
  page_count: 3,
  content_version: 1,
  created_at: "",
  updated_at: "",
  pending: { annotations: 0, stale_pages: 0, open_mrs: 1 },
  purpose: "",
  schema: "",
};

function mergeRequest(over: Partial<KbMergeRequest> = {}): KbMergeRequest {
  return {
    id: "mr-16",
    number: 16,
    knowledge_base_id: "kb-1",
    title: "Dedup by trade no",
    summary: "Handled the annotation.",
    source: "annotations",
    status: "open",
    risk: "low",
    author_type: "member",
    author_id: "user-1",
    author_name: "Wang Fang",
    draft_id: "draft-1",
    draft_version: 9,
    annotation_ids: ["a-1", "a-2"],
    origin: { type: "kb_job", label: "Handle annotations", ref_id: "job-1", openable: true },
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
    mention: "",
    ...over,
  };
}

function detail(over: Partial<KbMergeRequestDetail> = {}): KbMergeRequestDetail {
  return {
    ...mergeRequest(),
    knowledge_base_slug: "team",
    knowledge_base_name: "团队知识库",
    pages: [
      {
        page_id: "page-cb",
        path: "/payment/callback",
        old_path: "",
        title: "Callback",
        change: "modified",
        added: 1,
        deleted: 1,
        lines: [
          { kind: "context", text: "## Dedup", block_id: "b3", old_line: 14, new_line: 14 },
          { kind: "delete", text: "Dedup by order id.", block_id: "b4", old_line: 15, new_line: 0 },
          { kind: "add", text: "Dedup by trade no.", block_id: "b4", old_line: 0, new_line: 15 },
        ],
      },
    ],
    checks: { lint: [], conflicts: [] },
    agent_running: false,
    owner_id: "user-1",
    owner_name: "Wang Fang",
    reviews: [],
    pending_review: null,
    can_merge: true,
    can_close: true,
    can_revert: true,
    can_review: true,
    can_request_review: false,
    ...over,
  };
}

const REVIEW: KbMrReview = {
  id: "rv-1",
  merge_request_id: "mr-16",
  reviewer_user_id: "user-3",
  reviewer_name: "Li Lei",
  state: "pending",
  summary: "",
  comment_count: 0,
  created_at: "2026-10-25T10:36:00Z",
  submitted_at: null,
};

const COMMENT: KbMrComment = {
  id: "c-1",
  merge_request_id: "mr-16",
  parent_id: null,
  quote: { page_id: "page-cb", block_id: "b4", text: "Dedup by trade no." },
  body: "Say why.",
  author_type: "member",
  author_id: "user-3",
  author_name: "Li Lei",
  review_id: "rv-1",
  state: "published",
  created_at: "2026-10-25T10:38:00Z",
};

const asEntry = (c: KbMrComment): KbMrTimelineEntry => ({ type: "comment", ...c });

function makeAdapter(pathname: string): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function mount(ui: ReactElement, pathname: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={makeAdapter(pathname)}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

async function openReview(d: KbMergeRequestDetail, timeline: KbMrTimelineEntry[] = []) {
  mocked.getKnowledgeBaseMergeRequest.mockResolvedValue(d);
  mocked.listKnowledgeBaseMrTimeline.mockResolvedValue(timeline);
  mount(<KbReviewPage />, `/acme/kb/team/reviews/${d.number}`);
  await screen.findByRole("heading", { name: d.title });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.state.user.id = "user-3";
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.listKnowledgeBaseMergeRequests.mockResolvedValue([mergeRequest()]);
});

describe("review route helpers", () => {
  it("reads review and change log routes", () => {
    expect(parseKbReviewRoute("/acme/kb/team/reviews")).toEqual({ view: "reviews", kbSlug: "team", number: 0 });
    expect(parseKbReviewRoute("/acme/kb/team/reviews/16")).toEqual({ view: "reviews", kbSlug: "team", number: 16 });
    expect(parseKbReviewRoute("/acme/kb/t%20b/changes/3")).toEqual({ view: "changes", kbSlug: "t b", number: 3 });
    expect(parseKbReviewRoute("/acme/kb/team/jobs").view).toBeNull();
  });

  it("links each origin to where it was started", () => {
    const p = paths.workspace("acme");
    expect(kbOriginHref(p, "team", { type: "kb_job", label: "", ref_id: "job-1", openable: true }, null)).toBe("/acme/kb/team/jobs/job-1");
    expect(kbOriginHref(p, "team", { type: "revert", label: "", ref_id: "mr-1", openable: true }, 15)).toBe("/acme/kb/team/reviews/15");
    expect(kbOriginHref(p, "team", { type: "issue", label: "", ref_id: "i-1", openable: true }, null)).toBe("/acme/issues/i-1");
    expect(kbOriginHref(p, "team", { type: "chat", label: "", ref_id: "c-1", openable: true }, null)).toBe("/acme/chat?session=c-1");
    expect(kbOriginHref(p, "team", { type: "autopilot_run", label: "", ref_id: "ap-1", openable: true }, null)).toBe("/acme/autopilots/ap-1");
    expect(kbOriginHref(p, "team", { type: "none", label: "", ref_id: null, openable: true }, null)).toBeNull();
    // A job or chat started by someone else does not open for this viewer.
    expect(kbOriginHref(p, "team", { type: "kb_job", label: "", ref_id: "job-1", openable: false }, null)).toBeNull();
  });
});

describe("KbReviewPage", () => {
  it("lists open requests and merges with the draft version shown", async () => {
    mocked.mergeKnowledgeBaseMergeRequest.mockResolvedValue(mergeRequest({ status: "merged" }));
    await openReview(detail());

    const list = screen.getByRole("complementary", { name: "Change requests" });
    expect(within(list).getByRole("link", { name: /#16/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Knowledge base job · Handle annotations" })).toHaveAttribute("href", "/acme/kb/team/jobs/job-1");
    expect(screen.getByText("Can be merged into the mainline")).toBeInTheDocument();
    expect(screen.getByText(/Risk low · 1 page changed · 2 annotations handled/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(mocked.mergeKnowledgeBaseMergeRequest).toHaveBeenCalledWith(16, 9));
  });

  it("keeps merge for maintainers, and hides close from other members", async () => {
    await openReview(detail({ can_merge: false, can_close: false }));

    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(screen.getByText("The knowledge base creator or an owner / admin merges")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("shows conflicts and keeps merge disabled", async () => {
    await openReview(
      detail({
        checks: { lint: [], conflicts: [{ page_id: "page-cb", path: "/payment/callback", kind: "block", block_id: "b4", main_lines: "15-15", draft_lines: "15-16" }] },
      }),
    );

    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("Mainline lines 15-15")).toBeInTheDocument();
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(screen.getByText("Resolve the conflicts first")).toBeInTheDocument();
  });

  it("starts a review; without one there is no comment box", async () => {
    mocked.openKnowledgeBaseMrReview.mockResolvedValue(REVIEW);
    await openReview(detail());

    expect(screen.queryByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(mocked.openKnowledgeBaseMrReview).toHaveBeenCalledWith(16));
  });

  it("lets the owner start a review when the server allows it", async () => {
    auth.state.user.id = "user-1";
    await openReview(detail());

    expect(screen.getByRole("button", { name: "Start review" })).toBeInTheDocument();
  });

  it("hides start review when the server does not allow it", async () => {
    auth.state.user.id = "user-1";
    await openReview(detail({ can_review: false }));

    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("quotes a diff line into a pending comment and submits the review with a summary", async () => {
    const pending: KbMrComment = { ...COMMENT, id: "c-2", state: "pending", body: "Add the date." };
    mocked.createKnowledgeBaseMrComment.mockResolvedValue(pending);
    mocked.submitKnowledgeBaseMrReview.mockResolvedValue({ ...REVIEW, state: "submitted" });
    await openReview(detail({ pending_review: REVIEW }), [asEntry(pending)]);

    // The pending comment is marked and editable; the bar counts it.
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Pending")).toBeInTheDocument();
    expect(within(activity).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByText("1 pending comment, visible only to you")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Dedup by trade no\./ }));
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByText("Callback line 15")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "Say why.");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledWith(16, {
        body: "Say why.",
        review_id: "rv-1",
        parent_id: null,
        quote: { page_id: "page-cb", block_id: "b4", text: "Dedup by trade no." },
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Submit review (1)" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Summary (optional)" }), "One fix.");
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() => expect(mocked.submitKnowledgeBaseMrReview).toHaveBeenCalledWith(16, "rv-1", "One fix."));
  });

  it("edits and deletes a pending comment, and discards the review after confirming", async () => {
    const pending: KbMrComment = { ...COMMENT, state: "pending" };
    mocked.updateKnowledgeBaseMrComment.mockResolvedValue({ ...pending, body: "Say why it changed." });
    mocked.deleteKnowledgeBaseMrComment.mockResolvedValue(undefined);
    mocked.discardKnowledgeBaseMrReview.mockResolvedValue(undefined);
    await openReview(detail({ pending_review: REVIEW }), [asEntry(pending)]);

    const activity = screen.getByRole("region", { name: "Activity" });
    await userEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    const editor = within(activity).getByRole("textbox", { name: "Comment" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Say why it changed.");
    await userEvent.click(within(activity).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.updateKnowledgeBaseMrComment).toHaveBeenCalledWith(16, "c-1", "Say why it changed."));

    await userEvent.click(within(activity).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocked.deleteKnowledgeBaseMrComment).toHaveBeenCalledWith(16, "c-1"));

    await userEvent.click(screen.getByRole("button", { name: "Discard review" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard review" }));
    await waitFor(() => expect(mocked.discardKnowledgeBaseMrReview).toHaveBeenCalledWith(16, "rv-1"));
  });

  it("lets the owner reply in the thread and request review again while changes are requested", async () => {
    auth.state.user.id = "user-1";
    mocked.requestKnowledgeBaseMrReview.mockResolvedValue(mergeRequest());
    mocked.createKnowledgeBaseMrComment.mockResolvedValue({ ...COMMENT, id: "c-9", review_id: null });
    await openReview(detail({ status: "changes_requested", can_request_review: true }), [asEntry(COMMENT)]);

    expect(screen.getAllByText("Changes requested").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(screen.getByText("Request review again once the feedback is addressed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reply..." }));
    await userEvent.type(screen.getByRole("textbox", { name: "Reply" }), "Done.");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledWith(16, { body: "Done.", parent_id: "c-1" }));

    await userEvent.click(screen.getByRole("button", { name: "Request review again" }));
    await waitFor(() => expect(mocked.requestKnowledgeBaseMrReview).toHaveBeenCalledWith(16));
  });

  describe("Enter in a comment box", () => {
    it("adds to the review on Enter, breaks the line on Shift+Enter and only confirms an IME candidate", async () => {
      mocked.createKnowledgeBaseMrComment.mockResolvedValue({ ...COMMENT, id: "c-2", state: "pending" });
      await openReview(detail({ pending_review: REVIEW }));

      const box = screen.getByRole("textbox", { name: "Comment" });
      await userEvent.click(box);
      await userEvent.keyboard("{Enter}");
      expect(mocked.createKnowledgeBaseMrComment).not.toHaveBeenCalled();

      await userEvent.type(box, "Say why.");
      fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
      fireEvent.keyDown(box, { key: "Enter", isComposing: true });
      expect(mocked.createKnowledgeBaseMrComment).not.toHaveBeenCalled();

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}more");
      expect(box).toHaveValue("Say why.\nmore");
      expect(mocked.createKnowledgeBaseMrComment).not.toHaveBeenCalled();

      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledWith(16, {
          body: "Say why.\nmore",
          review_id: "rv-1",
          parent_id: null,
          quote: null,
        }),
      );
      expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(box).toHaveValue(""));
    });

    it("saves an edited pending comment on Enter and cancels on Escape", async () => {
      const pending: KbMrComment = { ...COMMENT, state: "pending" };
      mocked.updateKnowledgeBaseMrComment.mockResolvedValue({ ...pending, body: "Say why it changed." });
      await openReview(detail({ pending_review: REVIEW }), [asEntry(pending)]);

      const activity = screen.getByRole("region", { name: "Activity" });
      await userEvent.click(within(activity).getByRole("button", { name: "Edit" }));
      await userEvent.keyboard("{Escape}");
      expect(within(activity).queryByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();

      await userEvent.click(within(activity).getByRole("button", { name: "Edit" }));
      const editor = within(activity).getByRole("textbox", { name: "Comment" });
      await userEvent.clear(editor);
      await userEvent.type(editor, "Say why it changed.{Enter}");
      await waitFor(() => expect(mocked.updateKnowledgeBaseMrComment).toHaveBeenCalledWith(16, "c-1", "Say why it changed."));
    });

    it("sends an owner reply on Enter", async () => {
      auth.state.user.id = "user-1";
      mocked.createKnowledgeBaseMrComment.mockResolvedValue({ ...COMMENT, id: "c-9", review_id: null });
      await openReview(detail({ status: "changes_requested" }), [asEntry(COMMENT)]);

      await userEvent.click(screen.getByRole("button", { name: "Reply..." }));
      await userEvent.type(screen.getByRole("textbox", { name: "Reply" }), "Done.{Enter}");
      await waitFor(() => expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledWith(16, { body: "Done.", parent_id: "c-1" }));
    });

    it("submits the review summary on Enter", async () => {
      const pending: KbMrComment = { ...COMMENT, id: "c-2", state: "pending" };
      mocked.submitKnowledgeBaseMrReview.mockResolvedValue({ ...REVIEW, state: "submitted" });
      await openReview(detail({ pending_review: REVIEW }), [asEntry(pending)]);

      await userEvent.click(screen.getByRole("button", { name: "Submit review (1)" }));
      const summary = await screen.findByRole("textbox", { name: "Summary (optional)" });
      await userEvent.type(summary, "One fix.{Shift>}{Enter}{/Shift}Two.");
      expect(mocked.submitKnowledgeBaseMrReview).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(mocked.submitKnowledgeBaseMrReview).toHaveBeenCalledWith(16, "rv-1", "One fix.\nTwo."));
    });
  });

  it("mixes events into the activity and folds the earlier ones", async () => {
    const event = (id: string, kind: "review_submitted" | "review_requested" | "edited", payload: Record<string, unknown> = {}): KbMrTimelineEntry => ({
      type: "event",
      id,
      kind,
      actor_type: "member",
      actor_id: "user-3",
      actor_name: "Li Lei",
      payload,
      created_at: "2026-10-25T10:40:00Z",
    });
    await openReview(detail({ status: "changes_requested" }), [
      event("e-1", "edited", { fields: ["title"] }),
      event("e-2", "review_requested"),
      event("e-3", "review_requested"),
      event("e-4", "review_requested"),
      event("e-5", "review_submitted", { comment_count: 1, summary: "One fix." }),
      asEntry(COMMENT),
    ]);

    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("submitted a review · 1 comment")).toBeInTheDocument();
    expect(within(activity).getByText("One fix.")).toBeInTheDocument();
    expect(within(activity).queryByText("edited the title")).not.toBeInTheDocument();
    await userEvent.click(within(activity).getByRole("button", { name: "Show 1 earlier activity" }));
    expect(within(activity).getByText("edited the title")).toBeInTheDocument();
  });

  it("confirms closing with the annotations that go back to pending", async () => {
    mocked.closeKnowledgeBaseMergeRequest.mockResolvedValue(mergeRequest({ status: "closed" }));
    await openReview(detail());

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("The 2 annotations it handles go back to pending.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reason (optional)" }), "not needed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocked.closeKnowledgeBaseMergeRequest).toHaveBeenCalledWith(16, "not needed"));
  });

  it("reverts a merged request after confirming", async () => {
    mocked.revertKnowledgeBaseMergeRequest.mockResolvedValue(mergeRequest({ number: 18, source: "revert" }));
    await openReview(detail({ status: "merged", merged_by: "user-2", merged_by_name: "Li Lei", merged_at: "2026-10-25T11:02:00Z" }));

    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revert this change" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit revert" }));
    await waitFor(() => expect(mocked.revertKnowledgeBaseMergeRequest).toHaveBeenCalledWith(16));
  });
});

describe("KbChangesPage", () => {
  it("lists merged requests and shows the selected one's changes", async () => {
    const merged = mergeRequest({ status: "merged", merged_by_name: "Li Lei", merged_at: "2026-10-25T11:02:00Z" });
    mocked.listKnowledgeBaseMergeRequests.mockResolvedValue([merged]);
    mocked.getKnowledgeBaseMergeRequest.mockResolvedValue(detail({ status: "merged", merged_by_name: "Li Lei" }));
    mount(<KbChangesPage />, "/acme/kb/team/changes");

    expect(await screen.findByRole("link", { name: "Dedup by trade no" })).toHaveAttribute("href", "/acme/kb/team/reviews/16");
    expect(mocked.listKnowledgeBaseMergeRequests).toHaveBeenCalledWith({ status: "merged", kb: "team", limit: 100 });
    expect(screen.getByText("#16 · Wang Fang · merged by Li Lei")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert this change" })).toBeInTheDocument();
  });
});
