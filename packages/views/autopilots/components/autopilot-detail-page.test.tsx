import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Autopilot, AutopilotRun, AutopilotTrigger } from "@marvis/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { formatInTimeZone } from "../../common/format-in-time-zone";

// The detail page's chrome and layout: which controls a writer and a reader
// get, where delete lives now, and the status block's next-run readout.

let detail: { autopilot: Autopilot; triggers: AutopilotTrigger[]; collaborators: [] } | null = null;
let runs: AutopilotRun[] = [];

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@marvis/core/paths", () => ({
  useWorkspacePaths: () => ({
    autopilots: () => "/ws/autopilots",
    issueDetail: (id: string) => `/ws/issues/${id}`,
    autopilotRun: (id: string, runId: string) => `/ws/autopilots/${id}/runs/${runId}`,
    projectDetail: (id: string) => `/ws/projects/${id}`,
    agentDetail: (id: string) => `/ws/agents/${id}`,
  }),
}));
vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => `${type}-${id}` }),
}));
vi.mock("@marvis/core/autopilots/queries", () => ({
  autopilotDetailOptions: () => ({ queryKey: ["autopilot"], queryFn: async () => detail }),
  autopilotRunsOptions: () => ({ queryKey: ["runs"], queryFn: async () => runs }),
  autopilotRunOptions: () => ({ queryKey: ["run"], queryFn: async () => null }),
  autopilotDeliveriesOptions: () => ({ queryKey: ["deliveries"], queryFn: async () => [] }),
}));
vi.mock("@marvis/core/projects/queries", () => ({
  projectDetailOptions: () => ({ queryKey: ["project"], queryFn: async () => null }),
}));
vi.mock("@marvis/core/autopilots/mutations", () => ({
  useUpdateAutopilot: () => ({ mutate: vi.fn() }),
  useDeleteAutopilot: () => ({ mutateAsync: vi.fn() }),
  useTriggerAutopilot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateAutopilotTrigger: () => ({ mutateAsync: vi.fn() }),
  useDeleteAutopilotTrigger: () => ({ mutateAsync: vi.fn() }),
  useUpdateAutopilotTrigger: () => ({ mutateAsync: vi.fn() }),
  useRotateAutopilotTriggerWebhookToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("./autopilot-dialog", () => ({ AutopilotDialog: () => <div role="dialog">Edit autopilot</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AutopilotDetailPage } from "./autopilot-detail-page";

function autopilot(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    id: "ap-1",
    workspace_id: "ws",
    title: "Payment reconciliation",
    description: "Reconcile yesterday's payments.",
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
    can_write: true,
    ...overrides,
  };
}

function schedule(overrides: Partial<AutopilotTrigger>): AutopilotTrigger {
  return {
    id: "trg",
    autopilot_id: "ap-1",
    kind: "schedule",
    enabled: true,
    cron_expression: "0 2 * * *",
    timezone: "Asia/Shanghai",
    next_run_at: "2126-07-14T18:00:00Z",
    webhook_token: null,
    label: null,
    last_fired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function run(overrides: Partial<AutopilotRun>): AutopilotRun {
  return {
    id: "run",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "schedule",
    status: "completed",
    issue_id: null,
    task_id: null,
    triggered_at: "2026-10-27T02:00:00Z",
    completed_at: null,
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-10-27T02:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        value={{
          pathname: "/ws/autopilots/ap-1",
          searchParams: new URLSearchParams(),
          hash: "",
          push: vi.fn(),
          replace: vi.fn(),
          back: () => {},
          getShareableUrl: (v) => v,
        }}
      >
        <AutopilotDetailPage autopilotId="ap-1" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

describe("AutopilotDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detail = { autopilot: autopilot(), triggers: [], collaborators: [] };
    runs = [];
  });

  it("puts edit, delete and run now in the header, with no danger zone below", async () => {
    const user = userEvent.setup();
    renderPage();

    const header = (await screen.findByRole("heading", { name: "Payment reconciliation" })).closest("header")!;
    expect(within(header).getByRole("button", { name: "Back to autopilots" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.queryByText("Danger Zone")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add trigger" })).toHaveTextContent("Add");

    await user.click(within(header).getByRole("button", { name: "Delete autopilot" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Payment reconciliation/)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("shows a reader no edit, delete, run now or trigger management", async () => {
    detail = {
      autopilot: autopilot({ can_write: false }),
      triggers: [schedule({ id: "daily" })],
      collaborators: [],
    };
    renderPage();

    await screen.findByRole("heading", { name: "Payment reconciliation" });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete autopilot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add trigger" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit schedule" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Pause autopilot" })).toBeInTheDocument();
  });

  it("reads the next run from the soonest live schedule, in that schedule's zone", async () => {
    detail = {
      autopilot: autopilot(),
      triggers: [
        schedule({ id: "off", enabled: false, next_run_at: "2126-07-01T00:00:00Z" }),
        schedule({ id: "later", next_run_at: "2126-07-20T18:00:00Z" }),
        schedule({ id: "soon", next_run_at: "2126-07-14T18:00:00Z", timezone: "Asia/Tokyo" }),
      ],
      collaborators: [],
    };
    renderPage();

    const expected = formatInTimeZone("2126-07-14T18:00:00Z", "Asia/Tokyo", "en");
    expect(await screen.findByText(`Next run: ${expected}`)).toBeInTheDocument();
  });

  it("promises no next run and blocks run now while paused", async () => {
    detail = {
      autopilot: autopilot({ status: "paused" }),
      triggers: [schedule({ id: "daily" })],
      collaborators: [],
    };
    renderPage();

    await screen.findByRole("heading", { name: "Payment reconciliation" });
    expect(screen.queryByText(/^Next run:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Activate autopilot" })).not.toBeChecked();
  });

  it("lists runs with their summary and source, keeping skipped runs folded", async () => {
    const user = userEvent.setup();
    runs = [
      run({ id: "failed", status: "failed", failure_reason: "runtime offline" }),
      run({ id: "linked", status: "issue_created", issue_id: "iss-1", source: "manual" }),
      run({ id: "skip-1", status: "skipped", failure_reason: "assignee offline" }),
    ];
    renderPage();

    expect(await screen.findByText("runtime offline")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Issue linked/ })).toHaveAttribute("href", "/ws/issues/iss-1");
    expect(screen.queryByText("assignee offline")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /1 skipped runs/ }));

    expect(screen.getByText("assignee offline")).toBeInTheDocument();
  });

  it("opens a run_only run on its run page, with no transcript button left", async () => {
    runs = [
      run({ id: "done", status: "completed", task_id: "11111111-1111-4111-8111-111111111111" }),
      run({ id: "skip-1", status: "skipped", failure_reason: "assignee offline" }),
    ];
    renderPage();

    const row = await screen.findByRole("link", { name: /Completed/ });
    expect(row).toHaveAttribute("href", "/ws/autopilots/ap-1/runs/done");
    expect(screen.queryByRole("button", { name: /execution log/i })).not.toBeInTheDocument();
  });

  it("keeps create_issue runs without an issue as plain rows", async () => {
    detail = {
      autopilot: autopilot({ execution_mode: "create_issue" }),
      triggers: [],
      collaborators: [],
    };
    runs = [
      run({ id: "failed", status: "failed", failure_reason: "runtime offline" }),
      run({ id: "linked", status: "issue_created", issue_id: "iss-1" }),
    ];
    renderPage();

    expect(await screen.findByText("runtime offline")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Issue linked/ })).toHaveAttribute("href", "/ws/issues/iss-1");
  });

  it("hides the instructions block when there are none", async () => {
    detail = { autopilot: autopilot({ description: null }), triggers: [], collaborators: [] };
    renderPage();

    await screen.findByRole("heading", { name: "Payment reconciliation" });
    expect(screen.queryByRole("heading", { name: "Prompt" })).not.toBeInTheDocument();
  });
});
