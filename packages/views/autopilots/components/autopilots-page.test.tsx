import { useState } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import {
  AUTOPILOT_DEFAULT_HIDDEN_COLUMNS,
  useAutopilotsViewStore,
} from "@marvis/core/autopilots/stores";
import type { Autopilot } from "@marvis/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { AutopilotsPage } from "./autopilots-page";

vi.mock("@marvis/core/api", () => ({ api: { listAutopilots: vi.fn() } }));
vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@marvis/core/paths", () => ({
  useWorkspacePaths: () => ({
    autopilots: () => "/ws/autopilots",
    autopilotDetail: (id: string) => `/ws/autopilots/${id}`,
  }),
}));
vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) => `${type}-${id}`,
  }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("./autopilot-list-actions", () => ({
  AutopilotRowActions: () => <button type="button">Row menu</button>,
}));
vi.mock("./workspace-wakeups", () => ({
  WorkspaceWakeups: () => <div>Wakeup inventory</div>,
  WorkspaceWakeupCreate: ({ open }: { open: boolean }) => (open ? <div>Wakeup create</div> : null),
}));
vi.mock("./autopilot-dialog", () => ({
  AutopilotDialog: ({ initial }: { initial?: { title?: string } }) => (
    <div role="dialog">{initial?.title ?? "Blank autopilot"}</div>
  ),
}));
// The list virtualizes; render every card row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 140,
        end: (index + 1) * 140,
        size: 140,
      })),
    getTotalSize: () => count * 140,
  }),
}));

function autopilot(overrides: Partial<Autopilot>): Autopilot {
  return {
    id: "a1",
    workspace_id: "ws",
    title: "Daily standup",
    description: null,
    assignee_type: "agent",
    assignee_id: "bot",
    status: "active",
    execution_mode: "run_only",
    issue_title_template: null,
    created_by_type: "member",
    created_by_id: "lin",
    last_run_at: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    trigger_kinds: ["schedule"],
    next_run_at: null,
    ...overrides,
  };
}

function Harness() {
  const [path, setPath] = useState("/ws/autopilots?keep=yes");
  const url = new URL(path, "https://example.test");
  return (
    <NavigationProvider
      value={{
        pathname: url.pathname,
        searchParams: url.searchParams,
        hash: "",
        push: setPath,
        replace: setPath,
        back: () => {},
        getShareableUrl: (v) => v,
      }}
    >
      <AutopilotsPage />
    </NavigationProvider>
  );
}

function renderPage(autopilots: Autopilot[]) {
  vi.mocked(api.listAutopilots).mockResolvedValue({
    autopilots,
    total: autopilots.length,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAutopilotsViewStore.setState({
    scope: "all",
    hiddenColumns: AUTOPILOT_DEFAULT_HIDDEN_COLUMNS,
    filters: { assignees: [], modes: [], triggerKinds: [], creators: [] },
  });
});

it.each(["empty", "error"])(
  "keeps wakeups reachable when autopilots are %s",
  async (state) => {
    if (state === "empty")
      vi.mocked(api.listAutopilots).mockResolvedValue({ autopilots: [], total: 0 });
    else
      vi.mocked(api.listAutopilots).mockRejectedValue(
        new Error("Autopilots unavailable"),
      );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await screen.findByText(
      state === "empty" ? "No autopilots yet" : "Autopilots unavailable",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Issue wakeups" }));
    expect(await screen.findByText("Wakeup inventory")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New autopilot" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New wakeup" }));
    expect(await screen.findByText("Wakeup create")).toBeVisible();
    fireEvent.click(
      screen.getByRole("tab", { name: "Autopilot" }),
    );
    expect(
      await screen.findByRole("button", { name: "New autopilot" }),
    ).toBeVisible();
  },
);

describe("autopilot cards", () => {
  it("lays cards out two per line once the list mounts after loading", async () => {
    // The scroll container only exists after the list query resolves, so the
    // column measurement must start when it mounts, not on the page's first render.
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    try {
      renderPage([
        autopilot({ id: "a1", title: "Daily standup" }),
        autopilot({ id: "a2", title: "Weekly report" }),
      ]);

      const first = await screen.findByRole("listitem", { name: "Daily standup" });
      const second = screen.getByRole("listitem", { name: "Weekly report" });
      expect(first.parentElement).toBe(second.parentElement);
      expect(first.parentElement?.style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
    } finally {
      width.mockRestore();
    }
  });

  it("keeps a lone card at half width instead of stretching across the line", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    try {
      renderPage([autopilot({ id: "a1", title: "Daily standup" })]);

      const card = await screen.findByRole("listitem", { name: "Daily standup" });
      expect(card.parentElement?.style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
    } finally {
      width.mockRestore();
    }
  });

  it("shows the title, a plain-text instructions preview and the default meta fields", async () => {
    renderPage([
      autopilot({
        description: "## Goal\n- Ping [@Alice](mention://member/1) **daily**",
      }),
    ]);

    const card = await screen.findByRole("listitem", { name: "Daily standup" });
    expect(within(card).getByText("Goal Ping @Alice daily")).toBeVisible();
    expect(within(card).getByText("agent-bot")).toBeVisible();
    expect(within(card).getByText("Schedule")).toBeVisible();
    expect(within(card).getByText("Never run")).toBeVisible();
    expect(within(card).queryByText("Run Only")).toBeNull();
    expect(within(card).queryByText("member-lin")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("follows the display field switches", async () => {
    useAutopilotsViewStore.setState({ hiddenColumns: ["assignee", "lastRun"] });
    renderPage([autopilot({})]);

    const card = await screen.findByRole("listitem", { name: "Daily standup" });
    expect(within(card).queryByText("agent-bot")).toBeNull();
    expect(within(card).queryByText("Never run")).toBeNull();
    expect(within(card).getByText("Run Only")).toBeVisible();
    expect(within(card).getByText("member-lin")).toBeVisible();
  });

  it("marks paused autopilots next to the title", async () => {
    renderPage([autopilot({ status: "paused" })]);

    const card = await screen.findByRole("listitem", { name: "Daily standup" });
    expect(within(card).getByTitle("Paused")).toBeInTheDocument();
  });

  it("shows the no-match message when filters exclude every card", async () => {
    useAutopilotsViewStore.setState({
      filters: { assignees: [], modes: ["create_issue"], triggerKinds: [], creators: [] },
    });
    renderPage([autopilot({})]);

    expect(await screen.findByText("No automations match")).toBeVisible();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("new autopilot menu", () => {
  it.each([
    ["with autopilots", [autopilot({})]],
    ["without autopilots", []],
  ])("offers blank and template starts %s", async (_name, rows) => {
    renderPage(rows);

    fireEvent.click(await screen.findByRole("button", { name: "New autopilot" }));
    expect(
      await screen.findByRole("menuitem", { name: /Start from scratch/ }),
    ).toBeVisible();
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Daily news digest/ }));
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Daily news digest");
  });

  it("opens a blank create dialog from the first item", async () => {
    renderPage([autopilot({})]);

    fireEvent.click(await screen.findByRole("button", { name: "New autopilot" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: /Start from scratch/ }));
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Blank autopilot");
  });
});
