import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { addDaysDateOnly } from "@marvis/core/issues/date";
import type { Issue } from "@marvis/core/types";
import en from "../../locales/en/issues.json";
import { BoardCardContent } from "./board-card";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));

vi.mock("@marvis/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@marvis/core/properties", () => ({
  propertyListOptions: () => ({ queryKey: ["properties"] }),
}));

vi.mock("@marvis/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => ({
    categoryOf: (status: string) => (status === "done" ? "done" : "unstarted"),
  }),
}));

const viewState = vi.hoisted(() => ({
  viewMode: "board",
  grouping: "status",
  swimlaneGrouping: "assignee",
  cardProperties: {
    priority: false,
    description: false,
    assignee: false,
    startDate: true,
    dueDate: true,
    project: false,
    childProgress: true,
    labels: true,
  },
  cardPropertyIds: [],
}));

vi.mock("@marvis/core/issues/stores/view-store-context", () => ({
  useViewStore: (selector: (state: typeof viewState) => unknown) => selector(viewState),
}));

vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: () => ({
    t: (selector: (strings: typeof en) => unknown, params: Record<string, unknown> = {}) => {
      // Resolve plural keys the way i18next does for English.
      const resolved = selector(
        new Proxy(en, {
          get: (target, key: string) =>
            key === "card"
              ? {
                  ...target.card,
                  overdue_days:
                    params.count === 1
                      ? target.card.overdue_days_one
                      : target.card.overdue_days_other,
                }
              : target[key as keyof typeof en],
        }),
      );
      return String(resolved).replace(/{{(\w+)}}/g, (_, key: string) => String(params[key] ?? ""));
    },
  }),
  useTimeAgo: () => () => "4h ago",
}));

vi.mock("./custom-status-chip", () => ({
  CustomStatusChip: () => null,
  useIsCustomStatus: () => false,
}));

// The real indicator reads the agent snapshot; here it only has to show that the
// card hands it the "updated" hint as the idle fallback.
vi.mock("./issue-agent-activity-indicator", () => ({
  IssueAgentActivityIndicator: ({ fallback }: { fallback?: ReactNode }) => <>{fallback}</>,
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-1",
    title: "Card title",
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    labels: [],
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T00:00:00Z",
    ...overrides,
  } as Issue;
}

describe("BoardCardContent footer", () => {
  it("shows the last update when no agent is active", () => {
    render(<BoardCardContent issue={makeIssue()} />);

    expect(screen.getByText("Updated 4h ago")).toBeInTheDocument();
  });

  it("shows an overdue due date as days overdue in the urgent colour", () => {
    render(
      <BoardCardContent
        issue={makeIssue({ start_date: addDaysDateOnly(-10), due_date: addDaysDateOnly(-3) })}
      />,
    );

    const due = screen.getByText("3 days overdue");
    expect(due.className).toContain("text-priority-urgent");
  });

  it("joins start and due dates into a range", () => {
    const { container } = render(
      <BoardCardContent
        issue={makeIssue({ start_date: addDaysDateOnly(1), due_date: addDaysDateOnly(3) })}
      />,
    );

    expect(container.textContent).toContain("\u00a0–\u00a0");
  });

  it("separates dates from child progress", () => {
    const { container } = render(
      <BoardCardContent
        issue={makeIssue({ due_date: addDaysDateOnly(3) })}
        childProgress={{ done: 2, total: 5 }}
      />,
    );

    expect(screen.getByText("2/5")).toBeInTheDocument();
    expect(container.textContent).toContain(" · ");
  });
});

describe("BoardCardContent body", () => {
  it("mutes the title of a finished issue", () => {
    render(<BoardCardContent issue={makeIssue({ status: "done" })} />);

    expect(screen.getByText("Card title").className).toContain("text-muted-foreground");
  });

  it("renders labels as coloured dots with names, not pills", () => {
    const label = {
      id: "l1",
      workspace_id: "ws-1",
      name: "Bug",
      color: "#ef4444",
      created_at: "",
      updated_at: "",
    };
    const { container } = render(<BoardCardContent issue={makeIssue({ labels: [label] })} />);

    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="label-chip"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>('span[style*="background-color"]')?.style.backgroundColor,
    ).toBe("rgb(239, 68, 68)");
  });
});
