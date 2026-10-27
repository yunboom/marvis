import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Autopilot, AutopilotRun, ChatMessage, TaskMessagePayload } from "@marvis/core/types";
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
      listAgents: vi.fn(),
      listMembers: vi.fn(),
      ensureAutopilotRunChat: vi.fn(),
      sendChatMessage: vi.fn(),
      listChatMessagesPage: vi.fn(),
      getPendingChatTask: vi.fn(),
    },
  };
});
vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@marvis/core/auth", () => {
  const state = { user: { id: "user-1" } };
  const useAuthStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});
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
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="avatar">{actorId}</span>,
}));

// The chat list is virtualised; the run page only decides what goes in it.
vi.mock("../../chat/components/chat-message-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chat/components/chat-message-list")>();
  return {
    ...actual,
    ChatMessageList: ({ header, messages }: { header?: ReactNode; messages: { id: string; content: string }[] }) => (
      <div>
        {header}
        <ol aria-label="follow-ups">
          {messages.map((m) => (
            <li key={m.id}>{m.content}</li>
          ))}
        </ol>
      </div>
    ),
  };
});
vi.mock("../../chat/components/chat-queue", () => ({ ChatQueue: () => null }));
vi.mock("../../chat/components/use-chat-draft-restore", () => ({
  useChatDraftRestore: () => ({ restoreDraftRequest: null, enqueueLocalRestore: vi.fn(), handleRestoreDraftApplied: vi.fn() }),
}));
vi.mock("../../chat/components/use-chat-task-actions", () => ({ useChatTaskActions: () => ({ cancelChatTask: vi.fn() }) }));

// The composer's real editor is out of scope: a textarea that reports what the
// run page asked of it.
vi.mock("../../chat/components/chat-input", () => ({
  ChatInput: ({
    onSend,
    disabled,
    disabledPlaceholder,
    draftKeyOverride,
  }: {
    onSend: (content: string) => unknown;
    disabled?: boolean;
    disabledPlaceholder?: string;
    draftKeyOverride?: string;
  }) => (
    <form
      aria-label="composer"
      data-draft-key={draftKeyOverride}
      onSubmit={(event) => {
        event.preventDefault();
        const input = (event.currentTarget.elements.namedItem("text") as HTMLTextAreaElement).value;
        void onSend(input);
      }}
    >
      <textarea name="text" aria-label="message" disabled={disabled} placeholder={disabled ? disabledPlaceholder : ""} />
      <button type="submit" disabled={disabled}>
        send
      </button>
    </form>
  ),
}));

import { api, ApiError } from "@marvis/core/api";
import { AutopilotRunPage } from "./autopilot-run-page";

const getAutopilot = vi.mocked(api.getAutopilot);
const getAutopilotRun = vi.mocked(api.getAutopilotRun);
const listTaskMessages = vi.mocked(api.listTaskMessages);
const listAgents = vi.mocked(api.listAgents);
const listMembers = vi.mocked(api.listMembers);
const ensureAutopilotRunChat = vi.mocked(api.ensureAutopilotRunChat);
const sendChatMessage = vi.mocked(api.sendChatMessage);
const listChatMessagesPage = vi.mocked(api.listChatMessagesPage);
const getPendingChatTask = vi.mocked(api.getPendingChatTask);

const RUN_AGENT = "agent-run";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: RUN_AGENT,
    name: "Coding agent",
    owner_id: "user-1",
    permission_mode: "private",
    runtime_id: "rt-1",
    runtime_bound: true,
    archived_at: null,
    invocation_targets: [],
    ...overrides,
  } as Agent;
}

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
    listAgents.mockResolvedValue([agent()]);
    listMembers.mockResolvedValue([]);
    listChatMessagesPage.mockResolvedValue({ messages: [], limit: 50, has_more: false, next_cursor: null });
    getPendingChatTask.mockResolvedValue({} as Awaited<ReturnType<typeof api.getPendingChatTask>>);
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

  describe("follow-up conversation", () => {
    const chatMessage = (id: string, role: string, content: string): ChatMessage =>
      ({
        id,
        chat_session_id: "chat-1",
        role,
        content,
        task_id: `task-${id}`,
        created_at: "2026-10-27T03:00:00Z",
      }) as ChatMessage;

    it("creates the run's conversation on the first follow-up and sends into it", async () => {
      const user = userEvent.setup();
      getAutopilotRun.mockResolvedValue(run({ agent_id: RUN_AGENT, chat_session_id: null }));
      ensureAutopilotRunChat.mockResolvedValue({ chat_session_id: "chat-1" });
      sendChatMessage.mockResolvedValue({
        message_id: "m-1",
        task_id: "task-m-1",
        created_at: "2026-10-27T03:00:00Z",
      } as Awaited<ReturnType<typeof api.sendChatMessage>>);
      // Only read once the session exists, i.e. after the send.
      listChatMessagesPage.mockResolvedValue({
        messages: [chatMessage("m-1", "user", "Which ones?")],
        limit: 50,
        has_more: false,
        next_cursor: null,
      });
      renderPage();

      const composer = await screen.findByRole("form", { name: "composer" });
      expect(composer).toHaveAttribute("data-draft-key", "autopilot-run:run-1");
      expect(screen.queryByRole("list", { name: "follow-ups" })).not.toBeInTheDocument();
      await user.type(within(composer).getByRole("textbox", { name: "message" }), "Which ones?");
      await user.click(within(composer).getByRole("button", { name: "send" }));

      await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith("chat-1", "Which ones?", undefined));
      expect(ensureAutopilotRunChat).toHaveBeenCalledTimes(1);
      expect(ensureAutopilotRunChat).toHaveBeenCalledWith("ap-1", "run-1");
      expect(await within(screen.getByRole("list", { name: "follow-ups" })).findByText("Which ones?")).toBeInTheDocument();
      // The run's own reply stays above the follow-ups.
      expect(screen.getByText("Found 3 mismatches.")).toBeInTheDocument();
    });

    it("continues an existing conversation without creating another", async () => {
      const user = userEvent.setup();
      getAutopilotRun.mockResolvedValue(run({ agent_id: RUN_AGENT, chat_session_id: "chat-1" }));
      listChatMessagesPage.mockResolvedValue({
        messages: [chatMessage("m-2", "assistant", "Three, listed above."), chatMessage("m-1", "user", "Which ones?")],
        limit: 50,
        has_more: false,
        next_cursor: null,
      });
      sendChatMessage.mockResolvedValue({
        message_id: "m-3",
        task_id: "task-m-3",
        created_at: "2026-10-27T03:05:00Z",
      } as Awaited<ReturnType<typeof api.sendChatMessage>>);
      renderPage();

      const followUps = await screen.findByRole("list", { name: "follow-ups" });
      expect(await within(followUps).findByText("Three, listed above.")).toBeInTheDocument();
      expect(screen.getByText("Found 3 mismatches.")).toBeInTheDocument();

      const composer = screen.getByRole("form", { name: "composer" });
      await user.type(within(composer).getByRole("textbox", { name: "message" }), "Fix them");
      await user.click(within(composer).getByRole("button", { name: "send" }));

      await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith("chat-1", "Fix them", undefined));
      expect(ensureAutopilotRunChat).not.toHaveBeenCalled();
    });

    it("does not send when the conversation cannot be created", async () => {
      const user = userEvent.setup();
      getAutopilotRun.mockResolvedValue(run({ agent_id: RUN_AGENT, chat_session_id: null }));
      ensureAutopilotRunChat.mockRejectedValue(new ApiError("run is still in progress", 409, "Conflict"));
      renderPage();

      const composer = await screen.findByRole("form", { name: "composer" });
      await user.type(within(composer).getByRole("textbox", { name: "message" }), "Which ones?");
      await user.click(within(composer).getByRole("button", { name: "send" }));

      await waitFor(() => expect(ensureAutopilotRunChat).toHaveBeenCalled());
      expect(sendChatMessage).not.toHaveBeenCalled();
    });

    it("keeps the composer closed while the run is in progress", async () => {
      getAutopilotRun.mockResolvedValue(run({ status: "running", completed_at: null, agent_id: RUN_AGENT }));
      renderPage();

      const input = within(await screen.findByRole("form", { name: "composer" })).getByRole("textbox", { name: "message" });
      expect(input).toBeDisabled();
      expect(input).toHaveAttribute("placeholder", "Follow up once the run finishes");
    });

    it("has no composer for a run without a task", async () => {
      getAutopilotRun.mockResolvedValue(run({ status: "skipped", task_id: null, completed_at: null }));
      renderPage();

      expect(await screen.findByText("This run did not execute.")).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "composer" })).not.toBeInTheDocument();
    });

    it("locks the composer when the reader may no longer run the agent", async () => {
      getAutopilotRun.mockResolvedValue(run({ agent_id: RUN_AGENT }));
      listAgents.mockResolvedValue([agent({ owner_id: "someone-else" })]);
      renderPage();

      expect(
        await screen.findByText("You no longer have permission to run Coding agent — this conversation is read-only."),
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole("form", { name: "composer" })).getByRole("textbox", { name: "message" }),
      ).toBeDisabled();
    });

    it("shows the agent the run executed on, not the autopilot's current assignee", async () => {
      getAutopilotRun.mockResolvedValue(run({ agent_id: RUN_AGENT }));
      renderPage();

      await screen.findByText("Found 3 mismatches.");
      const avatars = screen.getAllByTestId("avatar").map((avatar) => avatar.textContent);
      expect(avatars).toContain(RUN_AGENT);
      expect(avatars).not.toContain("bot");
    });
  });

  it("goes back to the autopilot", async () => {
    const user = userEvent.setup();
    const { push } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Back to autopilot" }));

    expect(push).toHaveBeenCalledWith("/ws/autopilots/ap-1");
  });
});
