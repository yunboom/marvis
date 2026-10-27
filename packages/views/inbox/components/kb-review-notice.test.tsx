import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import type { InboxItem, KbMergeRequestDetail, KbMrComment, KbMrReview } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbReviewNotice, KbReviewNoticeAction } from "./kb-review-notice";

vi.mock("@marvis/core/api", () => ({
  api: { getKnowledgeBaseMergeRequest: vi.fn(), listKnowledgeBaseMrComments: vi.fn() },
}));

const auth = vi.hoisted(() => ({ state: { user: { id: "user-1" } } }));
vi.mock("@marvis/core/auth", () => {
  const useAuthStore = Object.assign(
    (selector?: (s: typeof auth.state) => unknown) => (selector ? selector(auth.state) : auth.state),
    { getState: () => auth.state },
  );
  return { useAuthStore };
});

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspaceSlug: () => "acme" };
});

vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_type: string, id: string) => (id === "user-2" ? "Wang Fang" : "Mu") }),
}));

vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));

const mocked = vi.mocked(api);

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "user-1",
    actor_type: "member",
    actor_id: "user-2",
    type: "kb_mr_changes_requested",
    severity: "action_required",
    issue_id: null,
    title: "#16 Dedup by trade no",
    body: "Fallback summary",
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-10-25T10:41:00Z",
    // The server sends the number as a JSON number.
    details: { knowledge_base_slug: "team", merge_request_number: 16 as unknown as string, review_id: "rv-1" },
    ...over,
  } as InboxItem;
}

const REVIEW: KbMrReview = {
  id: "rv-1",
  merge_request_id: "mr-16",
  reviewer_user_id: "user-2",
  reviewer_name: "Wang Fang",
  state: "submitted",
  summary: "Fix two things.",
  comment_count: 3,
  created_at: "",
  submitted_at: "2026-10-25T10:41:00Z",
};

function comment(id: string, body: string): KbMrComment {
  return {
    id,
    merge_request_id: "mr-16",
    parent_id: null,
    quote: null,
    body,
    author_type: "member",
    author_id: "user-2",
    author_name: "Wang Fang",
    review_id: "rv-1",
    state: "published",
    created_at: "",
  };
}

function mount(it: InboxItem) {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/inbox",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => path,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbReviewNotice item={it} />
        <KbReviewNoticeAction item={it} />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getKnowledgeBaseMergeRequest.mockResolvedValue({
    ...({} as KbMergeRequestDetail),
    number: 16,
    pages: [],
    reviews: [REVIEW],
  });
  mocked.listKnowledgeBaseMrComments.mockResolvedValue([comment("c-1", "Say why."), comment("c-2", "Add a link."), comment("c-3", "Typo.")]);
});

describe("KbReviewNotice", () => {
  it("shows the owner the review summary and the first comments", async () => {
    mount(item());

    expect(await screen.findByText("Fix two things.")).toBeInTheDocument();
    expect(screen.getByText("Wang Fang")).toBeInTheDocument();
    expect(screen.getByText("Review summary")).toBeInTheDocument();
    expect(await screen.findByText("Say why.")).toBeInTheDocument();
    expect(screen.getByText("Add a link.")).toBeInTheDocument();
    expect(screen.queryByText("Typo.")).toBeNull();
    expect(screen.getByRole("link", { name: "View all 3 comments" })).toHaveAttribute("href", "/acme/kb/team/reviews/16");
    expect(screen.getByRole("button", { name: "View feedback" })).toHaveAttribute("href", "/acme/kb/team/reviews/16");
    expect(mocked.getKnowledgeBaseMergeRequest).toHaveBeenCalledWith(16);
  });

  it("shows a reviewer their own summary when review is requested again", async () => {
    auth.state.user.id = "user-2";
    mount(item({ type: "kb_mr_review_requested", actor_id: "user-1", details: { knowledge_base_slug: "team", merge_request_number: "16" } }));

    expect(await screen.findByText("Your review summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to review" })).toBeInTheDocument();
    auth.state.user.id = "user-1";
  });

  it("falls back to the stored body when the request cannot be read", async () => {
    mocked.getKnowledgeBaseMergeRequest.mockRejectedValue(new Error("forbidden"));
    mount(item());

    expect(await screen.findByText("Fallback summary")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View feedback" })).toBeNull();
  });
});
