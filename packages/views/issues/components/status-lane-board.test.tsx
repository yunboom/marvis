/**
 * @vitest-environment jsdom
 *
 * Status board: four fixed columns of per-status lanes. Covers the lane
 * wiring — routing into columns, collapse persistence, the "N more" preview
 * cut, server paging on expand, and focus mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewStoreProvider } from "@marvis/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@marvis/core/issues/stores/surface-view-store";
import type { Issue, IssueStatus } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueContextMenuProvider } from "../actions/issue-actions-context-menu";
import type { IssueStatusPagination } from "../surface/use-issue-status-branches";
import { BoardView } from "./board-view";

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/api")>();
  const api = {
    listIssueStatuses: async () => ({ statuses: [], categories: [], total: 0 }),
    listIssueWorkflows: async () => ({ workflows: [] }),
    listProjects: async () => ({ projects: [], total: 0 }),
  };
  return { ...actual, api, getApi: () => api };
});

vi.mock("@marvis/core/properties", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/properties")>()),
  propertyListOptions: () => ({
    queryKey: ["properties"],
    queryFn: async () => [],
  }),
  useSetIssueProperty: () => ({ mutate: () => {} }),
  useUnsetIssueProperty: () => ({ mutate: () => {} }),
}));

vi.mock("@marvis/core/workspace/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/workspace/hooks")>()),
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("@marvis/core/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/auth")>()),
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "viewer-1" } }),
}));

vi.mock("@marvis/core/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/agents")>()),
  isAgentRuntimeBound: () => true,
  useAgentPresenceDetail: () => ({ availability: "offline", workload: null }),
}));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({
    push: () => {},
    openInNewTab: () => {},
    getShareableUrl: (path: string) => `https://app.example${path}`,
    pathname: "/",
  }),
  resolveClickIntent: () => "push",
  useIntentNavigate: () => () => {},
}));

function makeIssue(id: string, status: IssueStatus, position: number): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: position,
    identifier: `MUL-${id}`,
    title: `Task ${id}`,
    description: null,
    status,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: null,
    position,
    stage: null,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
    properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const TODO_ISSUES = Array.from({ length: 6 }, (_, i) => makeIssue(`todo${i + 1}`, "todo", i + 1));
const ISSUES = [
  ...TODO_ISSUES,
  makeIssue("progress1", "in_progress", 1),
  makeIssue("review1", "in_review", 1),
  makeIssue("done1", "done", 1),
  makeIssue("cancelled1", "cancelled", 1),
];
const VISIBLE: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function column(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function lane(status: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-board-lane="${status}"]`)!;
}

function laneToggle(status: string): HTMLElement {
  return within(lane(status)).getAllByRole("button")[0]!;
}

describe("Status lane board", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    vi.stubGlobal("ResizeObserver", ObserverStub);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function render({
    statusPagination,
  }: { statusPagination?: IssueStatusPagination } = {}) {
    const store = getIssueSurfaceViewStore(
      `board-lanes-${Math.floor(Math.random() * 1e9)}`,
    );
    store.getState().setGrouping("status");
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={store}>
          <IssueContextMenuProvider>
            <BoardView
              issues={ISSUES}
              visibleStatuses={VISIBLE}
              onMoveIssue={() => {}}
              onCreateIssue={() => {}}
              statusPagination={statusPagination}
            />
          </IssueContextMenuProvider>
        </ViewStoreProvider>
      </QueryClientProvider>,
    );

    return store;
  }

  it("routes statuses into the four fixed columns", () => {
    render();

    expect(
      Array.from(document.querySelectorAll("[data-board-status-column]")).map(
        (el) => el.getAttribute("data-board-status-column"),
      ),
    ).toEqual(["not_started", "started", "needs_attention", "ended"]);
    expect(column("Not started").querySelector('[data-board-lane="todo"]')).toBeTruthy();
    expect(column("Started").querySelector('[data-board-lane="in_progress"]')).toBeTruthy();
    expect(column("Started").querySelector('[data-board-lane="in_review"]')).toBeNull();
    expect(column("Needs attention").querySelector('[data-board-lane="in_review"]')).toBeTruthy();
    expect(column("Needs attention").querySelector('[data-board-lane="blocked"]')).toBeTruthy();
    expect(column("Ended").querySelector('[data-board-lane="cancelled"]')).toBeTruthy();
  });

  it("collapses empty and closed lanes by default", () => {
    render();

    expect(laneToggle("blocked").getAttribute("aria-expanded")).toBe("false");
    expect(laneToggle("blocked")).toHaveProperty("disabled", true);
    expect(laneToggle("cancelled").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Task cancelled1")).toBeNull();
    expect(laneToggle("done").getAttribute("aria-expanded")).toBe("true");
  });

  it("persists a lane's collapse in the view store", () => {
    const store = render();

    fireEvent.click(laneToggle("todo"));

    expect(store.getState().boardLaneCollapsed.todo).toBe(true);
    expect(laneToggle("todo").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Task todo1")).toBeNull();

    fireEvent.click(laneToggle("cancelled"));

    expect(store.getState().boardLaneCollapsed.cancelled).toBe(false);
    expect(screen.getByText("Task cancelled1")).toBeTruthy();
  });

  it("shows four cards, then expands in place and collapses back", () => {
    render();

    expect(screen.getByText("Task todo4")).toBeTruthy();
    expect(screen.queryByText("Task todo5")).toBeNull();

    fireEvent.click(within(lane("todo")).getByRole("button", { name: "2 more" }));

    expect(screen.getByText("Task todo6")).toBeTruthy();
    const collapse = within(lane("todo")).getByRole("button", { name: "Collapse" });

    fireEvent.click(collapse);

    expect(screen.queryByText("Task todo5")).toBeNull();
    expect(within(lane("todo")).getByRole("button", { name: "2 more" })).toBeTruthy();
  });

  it("counts unloaded server rows and fetches them on expand", () => {
    const loadMore = vi.fn();
    render({
      statusPagination: {
        todo: {
          total: 20,
          loaded: 6,
          hasMore: true,
          isLoading: false,
          isFetching: false,
          isError: false,
          loadMore,
          retry: () => {},
        },
      } as unknown as IssueStatusPagination,
    });

    // The end-of-lane sentinel pages the rest once it scrolls into view.
    vi.stubGlobal(
      "IntersectionObserver",
      class extends ObserverStub {
        constructor(private readonly callback: IntersectionObserverCallback) {
          super();
        }
        override observe() {
          this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
        }
      },
    );
    expect(loadMore).not.toHaveBeenCalled();

    fireEvent.click(within(lane("todo")).getByRole("button", { name: "16 more" }));

    expect(screen.getByText("Task todo6")).toBeTruthy();
    expect(loadMore).toHaveBeenCalled();
  });

  it("focuses one lane and pins the column's other lanes", () => {
    render();

    fireEvent.click(within(lane("todo")).getByRole("button", { name: "Focus Todo" }));

    const notStarted = column("Not started");
    expect(within(notStarted).getByText("Focused")).toBeTruthy();
    expect(lane("todo").getAttribute("data-lane-mode")).toBe("focused");
    expect(lane("backlog").getAttribute("data-lane-mode")).toBe("pinned");
    expect(screen.getByText("Task todo6")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(within(notStarted).queryByText("Focused")).toBeNull();
    expect(lane("backlog").getAttribute("data-lane-mode")).toBe("normal");
    expect(screen.queryByText("Task todo5")).toBeNull();
  });

  it("exits focus from the column header", () => {
    render();

    fireEvent.click(within(lane("todo")).getByRole("button", { name: "Focus Todo" }));
    fireEvent.click(within(column("Not started")).getByRole("button", { name: "Exit focus" }));

    expect(lane("todo").getAttribute("data-lane-mode")).toBe("normal");
  });
});
