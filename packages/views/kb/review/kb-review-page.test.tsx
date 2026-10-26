import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import { paths } from "@marvis/core/paths";
import type { KbMergeRequest, KbMergeRequestDetail, KbMrComment, KnowledgeBaseDetail } from "@marvis/core/types";
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
      createKnowledgeBaseMrComment: vi.fn(),
      mergeKnowledgeBaseMergeRequest: vi.fn(),
      closeKnowledgeBaseMergeRequest: vi.fn(),
      revertKnowledgeBaseMergeRequest: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

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
    origin: { type: "kb_job", label: "Handle annotations", ref_id: "job-1" },
    job_id: "job-1",
    reverts: null,
    merged_by: null,
    merged_by_name: "",
    merged_at: null,
    closed_by: null,
    closed_by_name: "",
    closed_at: null,
    close_reason: "",
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
    review_agent: { id: "agent-1", name: "Dev Helper" },
    agent_running: false,
    can_merge: true,
    can_close: true,
    can_revert: true,
    ...over,
  };
}

const COMMENT: KbMrComment = {
  id: "c-1",
  merge_request_id: "mr-16",
  parent_id: null,
  quote: { page_id: "page-cb", block_id: "b4", text: "Dedup by trade no." },
  body: "Say why.",
  author_type: "member",
  author_id: "user-2",
  author_name: "Li Lei",
  triggered: [{ agent_id: "agent-1", agent_name: "Dev Helper", reason: "author", chat_session_id: "chat-1", task_id: "t-1", running: true }],
  created_at: "2026-10-25T10:38:00Z",
};

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

async function openReview(d: KbMergeRequestDetail, comments: KbMrComment[] = []) {
  mocked.getKnowledgeBaseMergeRequest.mockResolvedValue(d);
  mocked.listKnowledgeBaseMrComments.mockResolvedValue(comments);
  mount(<KbReviewPage />, `/acme/kb/team/reviews/${d.number}`);
  await screen.findByRole("heading", { name: d.title });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(kbOriginHref(p, "team", { type: "kb_job", label: "", ref_id: "job-1" }, null)).toBe("/acme/kb/team/jobs/job-1");
    expect(kbOriginHref(p, "team", { type: "revert", label: "", ref_id: "mr-1" }, 15)).toBe("/acme/kb/team/reviews/15");
    expect(kbOriginHref(p, "team", { type: "issue", label: "", ref_id: "i-1" }, null)).toBe("/acme/issues/i-1");
    expect(kbOriginHref(p, "team", { type: "chat", label: "", ref_id: "c-1" }, null)).toBe("/acme/chat?session=c-1");
    expect(kbOriginHref(p, "team", { type: "autopilot_run", label: "", ref_id: "ap-1" }, null)).toBe("/acme/autopilots/ap-1");
    expect(kbOriginHref(p, "team", { type: "none", label: "", ref_id: null }, null)).toBeNull();
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

  it("shows conflicts and asks the agent to update from the mainline", async () => {
    mocked.createKnowledgeBaseMrComment.mockResolvedValue(COMMENT);
    await openReview(
      detail({
        checks: { lint: [], conflicts: [{ page_id: "page-cb", path: "/payment/callback", kind: "block", block_id: "b4", main_lines: "15-15", draft_lines: "15-16" }] },
      }),
    );

    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("Mainline lines 15-15")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(screen.getByText("Resolve the conflicts first")).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole("button"));
    await waitFor(() => expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalled());
    expect(mocked.createKnowledgeBaseMrComment.mock.calls[0]?.[1].body).toContain("draft-1");
  });

  it("quotes a selected diff line into the comment box and sends it", async () => {
    mocked.createKnowledgeBaseMrComment.mockResolvedValue(COMMENT);
    await openReview(detail(), [COMMENT]);

    // The thread shows who works on the comment and where it runs.
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Working")).toBeInTheDocument();
    expect(within(activity).getByRole("link", { name: "View run" })).toHaveAttribute("href", "/acme/kb/team/jobs/job-1");

    await userEvent.click(screen.getByRole("button", { name: /Dedup by trade no\./ }));
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByText("Callback line 15")).toBeInTheDocument();
    expect(screen.getByText("starts on send")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "Add the date.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mocked.createKnowledgeBaseMrComment).toHaveBeenCalledWith(16, {
        body: "Add the date.",
        parent_id: null,
        quote: { page_id: "page-cb", block_id: "b4", text: "Dedup by trade no." },
      }),
    );
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
