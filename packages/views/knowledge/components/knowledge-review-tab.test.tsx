// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

const memberRef = vi.hoisted(() => ({ current: { userId: "user-1", role: "member" as string } }));
const detailRef = vi.hoisted(() => ({ current: null as unknown }));
const apiMock = vi.hoisted(() => ({
  mergeKnowledgeChange: vi.fn(() => Promise.resolve()),
  closeKnowledgeChange: vi.fn(() => Promise.resolve()),
  commentOnKnowledgeChange: vi.fn(() => Promise.resolve()),
}));

const baseChange = {
  id: "cr-1",
  number: 12,
  title: "Fix refund rules",
  source: "fix",
  author_type: "agent",
  author_id: "agent-1",
  author_name: "Marvis",
  branch: "kb/fix",
  status: "open",
  conflict: false,
  conflict_files: [],
  summary: "Handled two annotations.",
  risk: "low",
  merge_commit: null,
  chat_session_id: null,
  annotation_ids: ["a1", "a2"],
  kb_slugs: ["team"],
  merged_at: null,
  created_at: "2026-10-25T09:12:00Z",
  updated_at: "",
};

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/permissions", () => ({
  useCurrentMember: () => ({ ...memberRef.current, member: null, isLoading: false }),
}));
vi.mock("@marvis/core/api", () => ({ api: apiMock, ApiError: class extends Error { status = 0; } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgeChangeListOptions: () => ({ queryKey: ["changes"], queryFn: () => Promise.resolve([baseChange]) }),
  knowledgeChangeOptions: (_ws: string, n: number | null) => ({
    queryKey: ["change", n],
    queryFn: () => Promise.resolve(detailRef.current),
    enabled: !!n,
  }),
}));

import { KnowledgeReviewTab } from "./knowledge-review-tab";

function renderTab() {
  const navigation: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/knowledge",
    searchParams: new URLSearchParams("tab=review"),
    hash: "",
    getShareableUrl: (p) => p,
  };
  const bases = [{ id: "kb-1", workspace_id: "ws-1", name: "Team", slug: "team", description: "", maintainer_agent_id: null, created_by: "", page_count: 0, created_at: "", updated_at: "" }];
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NavigationProvider value={navigation}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <KnowledgeReviewTab bases={bases} />
        </QueryClientProvider>
      </NavigationProvider>
    </I18nProvider>,
  );
}

describe("KnowledgeReviewTab", () => {
  beforeEach(() => {
    memberRef.current = { userId: "user-1", role: "member" };
    detailRef.current = {
      ...baseChange,
      groups: [
        {
          slug: "team",
          files: [
            {
              path: "team/wiki/concepts/refund.md",
              status: "modified",
              binary: false,
              added: 1,
              deleted: 1,
              lines: [
                { kind: "delete", text: "old line", old_line: 4, new_line: 0 },
                { kind: "add", text: "new line", old_line: 0, new_line: 4 },
              ],
            },
          ],
        },
      ],
      comments: [],
      checks: { lint: [], stale: [] },
    };
    vi.clearAllMocks();
  });

  it("shows lint and stale check results", async () => {
    detailRef.current = {
      ...(detailRef.current as object),
      checks: {
        lint: [
          { code: "broken_link", severity: "error", path: "team/wiki/concepts/refund.md", message: "link target gone.md does not exist" },
          { code: "orphan_page", severity: "warning", path: "team/wiki/concepts/refund.md", message: "no other page links to this page" },
        ],
        stale: [{ path: "team/wiki/concepts/refund.md", reason: "expired", claim_id: "", uri: "", version: "2020-01-01" }],
      },
    };
    renderTab();
    expect(await screen.findByText("Lint: 1 errors, 1 warnings")).toBeTruthy();
    expect(screen.getByText("Broken link · team/wiki/concepts/refund.md")).toBeTruthy();
    expect(screen.getByText("Pages past their review date: 1")).toBeTruthy();
  });

  it("reports clean checks", async () => {
    renderTab();
    expect(await screen.findByText("Lint: no issues")).toBeTruthy();
    expect(screen.getByText("No pages past their review date")).toBeTruthy();
  });

  it("disables merge for a plain member and says who can merge", async () => {
    renderTab();
    const merge = await screen.findByRole("button", { name: "Merge" });
    expect((merge as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("An owner or admin merges this")).toBeTruthy();
    expect(screen.getByText("Handled two annotations.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Team" })).toBeTruthy();
  });

  it("lets an admin merge", async () => {
    memberRef.current = { userId: "user-1", role: "admin" };
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Merge" }));
    await waitFor(() => expect(apiMock.mergeKnowledgeChange).toHaveBeenCalledWith(12));
  });

  it("posts a line comment from the diff", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Comment on line 4" }));
    await userEvent.type(screen.getByLabelText("Line comment"), "Cite the source");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(apiMock.commentOnKnowledgeChange).toHaveBeenCalledWith(12, { path: "team/wiki/concepts/refund.md", line: 4, body: "Cite the source" }),
    );
  });

  it("blocks merge on a conflict and shows the files", async () => {
    memberRef.current = { userId: "user-1", role: "owner" };
    detailRef.current = { ...(detailRef.current as object), conflict: true, conflict_files: ["team/wiki/concepts/refund.md"] };
    renderTab();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(((await screen.findByRole("button", { name: "Merge" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Resolve the conflict before merging")).toBeTruthy();
  });
});
