import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Autopilot, AutopilotRun, TaskMessagePayload } from "@marvis/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { formatInTimeZone } from "../../common/format-in-time-zone";

// The run page: what it shows for a run with and without a task, the webhook
// payload, the collapsible run details, and its not-found / forbidden states.

const TASK_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@marvis/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/api")>();
  return {
    ...actual,
    api: {
      getAutopilot: vi.fn(),
      getAutopilotRun: vi.fn(),
      listTaskMessages: vi.fn(),
    },
  };
});
vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return {
    ...actual,
    useWorkspaceSlug: () => "ws",
    useWorkspacePaths: () => actual.paths.workspace("ws"),
  };
});
vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Coding agent" }),
}));
vi.mock("@marvis/core/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/agents")>();
  return { ...actual, useAgentPresenceDetail: () => ({ availability: "online" }) };
});
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));

import { api, ApiError } from "@marvis/core/api";
import { AutopilotRunPage } from "./autopilot-run-page";

const getAutopilot = vi.mocked(api.getAutopilot);
const getAutopilotRun = vi.mocked(api.getAutopilotRun);
const listTaskMessages = vi.mocked(api.listTaskMessages);

function autopilot(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    id: "ap-1",
    workspace_id: "ws",
    title: "Payment reconciliation",
    description: "## Steps\n\nReconcile **yesterday's** payments.",
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
    ...overrides,
  };
}

function run(overrides: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    id: "run-1",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "schedule",
    status: "completed",
    issue_id: null,
    task_id: TASK_ID,
    triggered_at: "2026-10-27T02:00:00Z",
    completed_at: "2026-10-27T02:01:52Z",
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-10-27T02:00:00Z",
    ...overrides,
  };
}

function textMessage(seq: number, content: string): TaskMessagePayload {
  return { task_id: TASK_ID, issue_id: "", seq, type: "text", content };
}

function renderPage(push = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        value={{
          pathname: "/ws/autopilots/ap-1/runs/run-1",
          searchParams: new URLSearchParams(),
          hash: "",
          push,
          replace: vi.fn(),
          back: () => {},
          getShareableUrl: (v) => v,
        }}
      >
        <AutopilotRunPage autopilotId="ap-1" runId="run-1" />
      </NavigationProvider>
    </QueryClientProvider>,
  );

  return { push };
}

describe("AutopilotRunPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutopilot.mockResolvedValue({ autopilot: autopilot(), triggers: [], collaborators: [] });
    getAutopilotRun.mockResolvedValue(run());
    listTaskMessages.mockResolvedValue([textMessage(1, "Found 3 mismatches.")]);
  });

  it("shows the trigger, the execution reply and the run details", async () => {
    renderPage();

    const time = formatInTimeZone("2026-10-27T02:00:00Z", undefined, "en");
    const header = (
      await screen.findByRole("heading", { name: `Payment reconciliation · ${time}` })
    ).closest("header")!;
    expect(within(header).getByText("Autopilot run")).toBeInTheDocument();
    expect(within(header).getByText("Completed")).toBeInTheDocument();

    expect(screen.getByText("Scheduled run")).toBeInTheDocument();
    expect(screen.getByText("Reconcile yesterday's payments.", { exact: false })).toBeInTheDocument();
    expect(await screen.findByText("Found 3 mismatches.")).toBeInTheDocument();
    expect(listTaskMessages).toHaveBeenCalledWith(TASK_ID);
    expect(screen.getByText("Runtime online")).toBeInTheDocument();

    const panel = screen.getByRole("complementary", { name: "Run details" });
    expect(within(panel).getByText("Schedule")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /Payment reconciliation/ })).toHaveAttribute(
      "href",
      "/ws/autopilots/ap-1",
    );
    expect(within(panel).queryByText("Webhook payload")).not.toBeInTheDocument();
  });

  it("collapses and reopens the run details", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("complementary", { name: "Run details" });
    await user.click(screen.getByRole("button", { name: "Hide run details" }));

    expect(screen.queryByRole("complementary", { name: "Run details" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show run details" }));

    expect(screen.getByRole("complementary", { name: "Run details" })).toBeInTheDocument();
  });

  it("shows the webhook event and payload of a webhook run", async () => {
    getAutopilotRun.mockResolvedValue(
      run({
        source: "webhook",
        trigger_payload: { event: "channel.reconcile_requested", eventPayload: { channel: "wechat_pay" } },
      }),
    );
    renderPage();

    expect(await screen.findByText("Webhook run")).toBeInTheDocument();
    expect(screen.getByText(/channel\.reconcile_requested/, { selector: "span" })).toBeInTheDocument();

    const panel = screen.getByRole("complementary", { name: "Run details" });
    expect(within(panel).getByText("Webhook payload")).toBeInTheDocument();
    expect(within(panel).getByText(/wechat_pay/)).toBeInTheDocument();
  });

  it("shows only the trigger and run details for a run without a task", async () => {
    getAutopilotRun.mockResolvedValue(
      run({ status: "skipped", task_id: null, completed_at: null, failure_reason: "assignee runtime offline" }),
    );
    renderPage();

    expect(await screen.findByText("This run did not execute.")).toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: "Run details" });
    expect(within(panel).getByText("assignee runtime offline")).toBeInTheDocument();
    expect(within(panel).getByText("Failure reason")).toBeInTheDocument();
    expect(listTaskMessages).not.toHaveBeenCalled();
  });

  it("shows the live status while the run is running", async () => {
    getAutopilotRun.mockResolvedValue(run({ status: "running", completed_at: null }));
    renderPage();

    expect(await screen.findByText("Found 3 mismatches.")).toBeInTheDocument();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("says when the run does not exist", async () => {
    getAutopilotRun.mockRejectedValue(new ApiError("run not found", 404, "Not Found"));
    renderPage();

    expect(await screen.findByText("Run not found")).toBeInTheDocument();
  });

  it("says when the reader has no access", async () => {
    getAutopilot.mockRejectedValue(new ApiError("forbidden", 403, "Forbidden"));
    renderPage();

    expect(await screen.findByText("You don't have access to this run")).toBeInTheDocument();
  });

  it("offers a retry when loading fails for another reason", async () => {
    const user = userEvent.setup();
    getAutopilotRun.mockRejectedValueOnce(new ApiError("boom", 500, "Internal Server Error"));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(getAutopilotRun).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Found 3 mismatches.")).toBeInTheDocument();
  });

  it("goes back to the autopilot", async () => {
    const user = userEvent.setup();
    const { push } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Back to autopilot" }));

    expect(push).toHaveBeenCalledWith("/ws/autopilots/ap-1");
  });
});
