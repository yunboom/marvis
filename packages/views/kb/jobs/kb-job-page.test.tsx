import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import type { ChatPendingTask, KbJobDetail, KnowledgeBaseDetail } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbJobPage } from "./kb-job-page";
import { kbJobPanelState, memberPartOfJobMessage, parseKbJobRoute } from "./kb-job-state";

vi.mock("@marvis/core/api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    dispatchReasonCode: () => null,
    api: {
      getKnowledgeBase: vi.fn(),
      getKnowledgeBaseJob: vi.fn(),
      createKnowledgeBaseJob: vi.fn(),
      submitKnowledgeBaseJob: vi.fn(),
      discardKnowledgeBaseJob: vi.fn(),
      listAgents: vi.fn(),
      listRuntimes: vi.fn(),
      sendChatMessage: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

const setInputDraft = vi.fn();
vi.mock("@marvis/core/chat", () => ({ useChatStore: { getState: () => ({ setInputDraft }) } }));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("@marvis/core/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/agents")>();
  return { ...actual, useAgentPresenceDetail: () => ({ availability: "online" }) };
});

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="avatar">{actorId}</span>,
}));

vi.mock("../../autopilots/components/pickers/agent-picker", () => ({
  AgentPicker: ({ trigger }: { trigger: ReactElement }) => <div>{trigger}</div>,
}));

vi.mock("../../chat/components/chat-message-list", () => ({
  ChatMessageList: ({ messages }: { messages: { id: string; content: string }[] }) => (
    <ol aria-label="messages">
      {messages.map((m) => (
        <li key={m.id}>{m.content}</li>
      ))}
    </ol>
  ),
  ChatMessageSkeleton: () => <div>loading</div>,
}));

vi.mock("../../chat/components/chat-queue", () => ({ ChatQueue: () => null }));

// The composer's real editor is out of scope: a textarea that reports what
// the job page asked of it.
vi.mock("../../chat/components/chat-input", () => ({
  ChatInput: ({
    onSend,
    isRunning,
    disabled,
  }: {
    onSend: (content: string) => unknown;
    isRunning?: boolean;
    disabled?: boolean;
  }) => (
    <form
      aria-label="composer"
      data-running={isRunning ? "yes" : "no"}
      onSubmit={(event) => {
        event.preventDefault();
        const input = (event.currentTarget.elements.namedItem("text") as HTMLTextAreaElement).value;
        void onSend(input);
      }}
    >
      <textarea name="text" aria-label="message" disabled={disabled} />
      <button type="submit" disabled={disabled}>
        send
      </button>
    </form>
  ),
}));

const conversation = {
  messages: [] as { id: string; role: string; content: string }[],
  running: false,
  pendingTask: undefined as ChatPendingTask | undefined,
  send: vi.fn(async () => true),
};

vi.mock("./use-kb-job-conversation", () => ({
  useKbJobConversation: () => ({
    messages: conversation.messages,
    loading: false,
    pendingTask: conversation.pendingTask,
    running: conversation.running,
    firstItemIndex: 0,
    hasOlderMessages: false,
    isFetchingOlderMessages: false,
    fetchOlderMessages: () => {},
    send: conversation.send,
    stop: () => {},
    restoreDraftRequest: null,
    handleRestoreDraftApplied: () => {},
    queue: {
      handleSendQueuedTaskNow: () => {},
      handleEditQueuedTask: () => {},
      handleRemoveQueuedTask: () => {},
      handleClearQueuedTasks: () => {},
    },
  }),
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
  pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
  purpose: "",
  schema: "",
};

function job(over: Partial<KbJobDetail> = {}): KbJobDetail {
  return {
    id: "job-1",
    knowledge_base_id: "kb-1",
    name: "处理批注",
    starter: "annotations",
    agent_id: "agent-1",
    agent_name: "通用开发助手",
    chat_session_id: "chat-1",
    draft_id: "draft-1",
    created_by: "user-1",
    state: "idle",
    last_reply: "",
    draft: { version: 3, status: "open", pages: 1, added: 1, deleted: 1 },
    merge_request: null,
    annotation_ids: ["a-1"],
    page_id: null,
    created_at: "",
    updated_at: "",
    pages: [
      {
        page_id: "page-cb",
        path: "/payment/callback",
        old_path: "",
        title: "支付回调",
        change: "modified",
        added: 1,
        deleted: 1,
        lines: [
          { kind: "context", text: "## 去重", block_id: "b3", old_line: 14, new_line: 14 },
          { kind: "delete", text: "按订单号去重。", block_id: "b4", old_line: 15, new_line: 0 },
          { kind: "add", text: "按渠道交易号去重。", block_id: "b4", old_line: 0, new_line: 15 },
        ],
      },
    ],
    checks: { lint: [], conflicts: [] },
    ...over,
  };
}

const NO_DRAFT = job({ draft_id: null, draft: null, pages: [] });

function makeAdapter(pathname: string, search = ""): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(search),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function mount(adapter: NavigationAdapter) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbJobPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

async function openJob(detail: KbJobDetail) {
  mocked.getKnowledgeBaseJob.mockResolvedValue(detail);
  mount(makeAdapter("/acme/kb/team/jobs/job-1"));
  return screen.findByRole("region", { name: "Draft changes" });
}

beforeEach(() => {
  vi.clearAllMocks();
  conversation.messages = [];
  conversation.running = false;
  conversation.pendingTask = undefined;
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.listAgents.mockResolvedValue([
    { id: "agent-1", name: "通用开发助手", runtime_id: "rt-1", archived_at: null },
  ] as never);
  mocked.listRuntimes.mockResolvedValue([] as never);
});

describe("job state helpers", () => {
  it("reads job routes", () => {
    expect(parseKbJobRoute("/acme/kb/team/jobs")).toEqual({ view: "list", kbSlug: "team", jobId: "" });
    expect(parseKbJobRoute("/acme/kb/team/jobs/new")).toEqual({ view: "new", kbSlug: "team", jobId: "" });
    expect(parseKbJobRoute("/acme/kb/team/jobs/j%201")).toEqual({ view: "job", kbSlug: "team", jobId: "j 1" });
    expect(parseKbJobRoute("/acme/kb/team/p/x").view).toBeNull();
  });

  it("shows only the member's part of the first message", () => {
    const first = "Knowledge base: Team (`team`)\nJob: x\n\nHow to work:\n- ...\n\nMember's message:\n处理 4 条批注。";
    expect(memberPartOfJobMessage(first)).toBe("处理 4 条批注。");
    expect(memberPartOfJobMessage("just a follow-up")).toBe("just a follow-up");
  });

  it("covers the edge cases of designs 9.9–9.17", () => {
    expect(kbJobPanelState(NO_DRAFT, true)).toMatchObject({ view: "nodraft", showSubmit: true, canSubmit: false });
    expect(kbJobPanelState(job({ pages: [] }), true).view).toBe("empty");
    expect(kbJobPanelState(job({ pages: [] }), false)).toMatchObject({ view: "nochange", showSubmit: false, canDiscard: false });
    expect(kbJobPanelState(job(), false)).toMatchObject({ view: "changes", canSubmit: true, canDiscard: true });
    expect(kbJobPanelState(job(), true)).toMatchObject({ view: "changes", canSubmit: false });
    const lint = job({ checks: { lint: [{ code: "missing_meta", severity: "error", page_id: "p", path: "/p", block_id: "", message: "m" }], conflicts: [] } });
    expect(kbJobPanelState(lint, false)).toMatchObject({ canSubmit: false, lintErrors: 1 });
    const conflict = job({ checks: { lint: [], conflicts: [{ page_id: "p", path: "/p", kind: "block", block_id: "b4", main_lines: "1-1", draft_lines: "1-2" }] } });
    expect(kbJobPanelState(conflict, false)).toMatchObject({ canSubmit: true, hasConflicts: true });
    const mr = { id: "mr-1", number: 16, title: "t", status: "open" as const, author_type: "agent", author_id: "agent-1", author_name: "通用开发助手", merged_by_name: "", closed_by_name: "", close_reason: "" };
    expect(kbJobPanelState(job({ draft: { ...job().draft!, status: "submitted" }, merge_request: mr }), false)).toMatchObject({ view: "submitted", showSubmit: false });
    expect(kbJobPanelState(job({ merge_request: { ...mr, status: "closed" } }), false)).toMatchObject({ view: "changes", reopened: true, canSubmit: true });
    expect(kbJobPanelState(job({ draft: { ...job().draft!, status: "merged" }, merge_request: { ...mr, status: "merged" } }), false)).toMatchObject({ view: "merged", ended: true });
    expect(kbJobPanelState(job({ draft: { ...job().draft!, status: "discarded" } }), false)).toMatchObject({ view: "discarded", ended: true });
  });
});

describe("KbJobPage", () => {
  it("keeps the right side empty and submit disabled until the agent links a draft (9.17)", async () => {
    conversation.running = true;
    conversation.messages = [{ id: "m1", role: "user", content: "处理团队知识库的全部 4 条待处理批注。" }];
    const panel = await openJob(NO_DRAFT);

    expect(within(panel).getByText("No draft yet")).toBeInTheDocument();
    expect(within(panel).getByText("The agent's changes show here once it creates the draft.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(within(panel).queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(screen.getByRole("form", { name: "composer" })).toHaveAttribute("data-running", "yes");
    expect(screen.getByText("处理团队知识库的全部 4 条待处理批注。")).toBeInTheDocument();
  });

  it("shows the draft's file cards and submits it (9.4, 9.6)", async () => {
    mocked.submitKnowledgeBaseJob.mockResolvedValue({ id: "mr-1", number: 16, knowledge_base_id: "kb-1", title: "t", status: "open", draft_id: "draft-1", job_id: "job-1" });
    const panel = await openJob(job());

    expect(within(panel).getByText("Draft · not submitted")).toBeInTheDocument();
    expect(within(panel).getByText("按渠道交易号去重。")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "View in page" })).toHaveAttribute("href", "/acme/kb/team/p/page-cb?draft=draft-1");
    expect(within(panel).getByText("Format check passed")).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Collapse all" }));
    expect(within(panel).queryByText("按渠道交易号去重。")).toBeNull();

    await userEvent.click(within(panel).getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(mocked.submitKnowledgeBaseJob).toHaveBeenCalledWith("job-1"));
  });

  it("waits for the turn to end before submitting (9.11)", async () => {
    conversation.running = true;
    const panel = await openJob(job());

    expect(within(panel).getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(within(panel).getByText("Submit once the agent finishes this turn")).toBeInTheDocument();
  });

  it("blocks submitting on a check error and asks the agent to fix it (9.9)", async () => {
    const panel = await openJob(
      job({ checks: { lint: [{ code: "missing_meta", severity: "error", page_id: "p", path: "/payment/manual", block_id: "", message: "the page header has no description" }], conflicts: [] } }),
    );

    expect(within(panel).getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(within(panel).getByText("1 error to fix before submitting")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Ask the agent to fix" }));
    expect(conversation.send).toHaveBeenCalledWith("Fix the errors `marvis kb draft check draft-1` reports, then check again.");
  });

  it("lets a conflicting draft be submitted and offers an update from the mainline (9.12)", async () => {
    const panel = await openJob(
      job({ checks: { lint: [], conflicts: [{ page_id: "page-cb", path: "/payment/callback", kind: "block", block_id: "b4", main_lines: "15-15", draft_lines: "15-16" }] } }),
    );

    expect(within(panel).getByRole("button", { name: "Submit for review" })).toBeEnabled();
    expect(within(panel).getByText("Conflicts with the mainline: /payment/callback")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Ask the agent to update from the mainline" })).toBeInTheDocument();
  });

  it("records a turn without changes as no change needed (9.13)", async () => {
    const panel = await openJob(job({ pages: [] }));

    expect(within(panel).getByText("Nothing needed changing this time")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Submit for review" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("turns read-only when the agent submitted itself (9.10)", async () => {
    const panel = await openJob(
      job({
        draft: { version: 3, status: "submitted", pages: 1, added: 1, deleted: 1 },
        merge_request: { id: "mr-1", number: 16, title: "t", status: "open", author_type: "agent", author_id: "agent-1", author_name: "通用开发助手", merged_by_name: "", closed_by_name: "", close_reason: "" },
      }),
    );

    expect(within(panel).getByText("通用开发助手 submitted change request #16. The draft is in review and read-only here.")).toBeInTheDocument();
    expect(within(panel).getByText("Review #16").closest("a")).toHaveAttribute("href", "/acme/kb/team/reviews/16");
    expect(within(panel).queryByRole("button", { name: "Submit for review" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("offers resubmitting after the change request is closed (9.14)", async () => {
    const panel = await openJob(
      job({
        merge_request: { id: "mr-1", number: 16, title: "t", status: "closed", author_type: "member", author_id: "user-1", author_name: "我", merged_by_name: "", closed_by_name: "王芳", close_reason: "例子对不上" },
      }),
    );

    expect(within(panel).getByText("王芳 closed #16: “例子对不上”. The draft is kept; you can keep adjusting it.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Resubmit for review" })).toBeEnabled();
  });

  it("ends the conversation once merged (9.15)", async () => {
    const panel = await openJob(
      job({
        draft: { version: 3, status: "merged", pages: 1, added: 1, deleted: 1 },
        merge_request: { id: "mr-1", number: 16, title: "t", status: "merged", author_type: "member", author_id: "user-1", author_name: "我", merged_by_name: "王芳", closed_by_name: "", close_reason: "" },
      }),
    );

    expect(within(panel).getByText("王芳 merged #16. The changes are live.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "composer" })).toBeNull();
    expect(screen.getAllByText("This conversation has ended").length).toBeGreaterThan(0);
  });

  it("discards the draft after confirming", async () => {
    mocked.discardKnowledgeBaseJob.mockResolvedValue(NO_DRAFT);
    const panel = await openJob(job());

    await userEvent.click(within(panel).getByRole("button", { name: "Discard draft" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(mocked.discardKnowledgeBaseJob).toHaveBeenCalledWith("job-1"));
  });
});

describe("new job", () => {
  it("starts a job brought in from the annotations page with the chosen agent", async () => {
    mocked.createKnowledgeBaseJob.mockResolvedValue({ ...job(), id: "job-9" });
    const adapter = makeAdapter("/acme/kb/team/jobs/new", "starter=annotations&annotations=a-1,a-2&message=处理 2 条");
    mount(adapter);

    expect(await screen.findByRole("heading", { name: "Handle annotations" })).toBeInTheDocument();
    await screen.findByText("通用开发助手");
    // The entry point's request is written into the composer's draft.
    expect(setInputDraft).toHaveBeenCalledWith("kb-job-new:team", "处理 2 条");
    await userEvent.type(screen.getByRole("textbox", { name: "message" }), "处理 2 条");
    await userEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() =>
      expect(mocked.createKnowledgeBaseJob).toHaveBeenCalledWith("team", {
        agent_id: "agent-1",
        starter: "annotations",
        name: "Handle annotations",
        message: "处理 2 条",
        annotation_ids: ["a-1", "a-2"],
        page_id: undefined,
        sources: undefined,
      }),
    );
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team/jobs/job-9");
  });

  it("starts from an opener card", async () => {
    mocked.createKnowledgeBaseJob.mockResolvedValue({ ...job(), id: "job-10" });
    mount(makeAdapter("/acme/kb/team/jobs/new"));

    await screen.findByText("通用开发助手");
    await userEvent.click(await screen.findByRole("button", { name: /Health check/ }));

    await waitFor(() =>
      expect(mocked.createKnowledgeBaseJob).toHaveBeenCalledWith("team", {
        agent_id: "agent-1",
        starter: "health",
        name: "Health check",
        message: "Health check: Find stale pages, contradictions, orphan pages and claims whose code changed",
      }),
    );
  });
});
