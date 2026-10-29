import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { kbBuilderRuntimeKey, useKbBuilderRuntimeStore } from "@marvis/core/kb";
import type { ChatMessage, KbBuilderSession, KnowledgeBaseDetail, RuntimeDevice } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbBuilderPage } from "./kb-builder-page";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  missing: false,
  send: vi.fn().mockResolvedValue(true),
  destroy: vi.fn().mockResolvedValue(true),
  switchRuntime: vi.fn(),
}));

vi.mock("@marvis/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/api")>();
  return {
    ApiError: actual.ApiError,
    api: {
      listKbBuilderSessions: vi.fn(),
      createKbBuilderSession: vi.fn(),
      getKnowledgeBaseTemplates: vi.fn(),
      getKnowledgeBase: vi.fn(),
      createKnowledgeBase: vi.fn(),
      updateKnowledgeBase: vi.fn(),
      saveKbBuilderDraft: vi.fn().mockResolvedValue(undefined),
      setChatSessionArchived: vi.fn().mockResolvedValue({}),
      listRuntimes: vi.fn(),
      listMembers: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

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
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The chat transport is the shared builder hook's job (and its tests').
vi.mock("../../agents/create/use-builder-session", () => ({
  useBuilderSession: () => ({
    messages: h.messages,
    missing: h.missing,
    messagesLoading: false,
    pendingTask: undefined,
    pending: false,
    switchingRuntime: false,
    closing: false,
    error: null,
    restoreDraftRequest: null,
    handleRestoreDraftApplied: vi.fn(),
    send: h.send,
    stop: vi.fn(),
    destroy: h.destroy,
    switchRuntime: h.switchRuntime,
  }),
}));

// The model picker reads the runtime's model catalog; its own tests cover it.
vi.mock("../../agents/components/model-dropdown", () => ({
  ModelDropdown: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      Model
    </button>
  ),
}));

// The conversation column renders its own chat; here it shows the empty
// state the page hands it, or the (already decoded) messages, the notice, and
// a composer that sends through the page.
vi.mock("../../agents/create/builder-conversation", () => ({
  BuilderConversation: function MockConversation({
    messages,
    emptyState,
    notice,
    runtimeOnline,
    disabledPlaceholder,
    composerToolbar,
    onSend,
  }: {
    messages: ChatMessage[];
    emptyState: ReactNode;
    notice: ReactNode;
    runtimeOnline: boolean;
    disabledPlaceholder?: string;
    composerToolbar?: ReactNode;
    onSend: (content: string, commitInput?: () => void) => Promise<boolean>;
  }) {
    const [text, setText] = useState("");
    return (
      <div>
        {messages.length === 0 ? (
          <div>{emptyState}</div>
        ) : (
          <ul aria-label="transcript">
            {messages.map((message) => (
              <li key={message.id}>{message.content}</li>
            ))}
          </ul>
        )}
        {notice}
        <textarea
          aria-label="Message"
          disabled={!runtimeOnline}
          placeholder={runtimeOnline ? "" : disabledPlaceholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="button" disabled={!runtimeOnline} onClick={() => void onSend(text, () => setText(""))}>
          Send
        </button>
        {composerToolbar}
      </div>
    );
  },
}));

vi.mock("react-resizable-panels", () => ({ useDefaultLayout: () => ({}) }));
vi.mock("@marvis/ui/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));

vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => <div data-testid="rich">{content}</div>,
}));

const mocked = vi.mocked(api);

function makeRuntime(overrides: Partial<RuntimeDevice> = {}): RuntimeDevice {
  return {
    id: "rt-1",
    name: "Claude",
    status: "online",
    owner_id: "user-1",
    provider: "claude",
    visibility: "private",
    device_info: "laptop",
    ...overrides,
  } as unknown as RuntimeDevice;
}

const RUNTIME = makeRuntime();
const RUNTIME_2 = makeRuntime({ id: "rt-2", name: "Codex", provider: "codex" });

const DEFAULT_SCHEMA = "# Schema\n\nBuilt-in rules.";

const BASE: KnowledgeBaseDetail = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "团队知识库",
  slug: "team",
  description: "订单与支付",
  schema_mode: "default",
  created_by: "user-1",
  page_count: 3,
  content_version: 9,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-25T14:20:11Z",
  pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
  purpose: "# 目标\n\n读者：团队。",
  schema: "# Schema (created)",
};

function session(overrides: Partial<KbBuilderSession> = {}): KbBuilderSession {
  return {
    session_id: "s-1",
    mode: "create",
    knowledge_base_id: null,
    title: "Create a knowledge base",
    runtime_id: "rt-1",
    last_message_content: "",
    last_message_role: "assistant",
    last_message_at: "2026-10-25T09:16:00Z",
    draft: null,
    updated_at: "2026-10-25T09:16:00Z",
    ...overrides,
  };
}

function reply(content: string, id = "m-1"): ChatMessage {
  return { id, content, role: "assistant", chat_session_id: "s-1", task_id: "t-1", created_at: "2026-10-25T09:16:00Z" };
}

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
        <KbBuilderPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return adapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.messages = [];
  h.missing = false;
  mocked.listKbBuilderSessions.mockResolvedValue([]);
  mocked.getKnowledgeBaseTemplates.mockResolvedValue({ default_schema: DEFAULT_SCHEMA, purpose_template: "# Purpose" });
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.listRuntimes.mockResolvedValue([RUNTIME]);
  mocked.listMembers.mockResolvedValue([{ user_id: "user-1", role: "member", name: "Me" }] as never);
  mocked.saveKbBuilderDraft.mockResolvedValue(undefined);
  mocked.setChatSessionArchived.mockResolvedValue({} as never);
});

afterEach(() => useKbBuilderRuntimeStore.setState({ byKey: {} }));

const runtimeTrigger = () => screen.findByRole("button", { name: /^Runtime: / });

describe("KbBuilderPage · direct entry", () => {
  it("opens straight on the conversation and configuration, with starters", async () => {
    mount(makeAdapter("/acme/kb/new"));

    const starter = await screen.findByRole("button", { name: /^Engineering knowledge base/ });
    await waitFor(() => expect(starter).toBeEnabled());
    expect(screen.getByRole("button", { name: /^Testing knowledge base/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(await runtimeTrigger()).toHaveAccessibleName("Runtime: Claude");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(mocked.createKbBuilderSession).not.toHaveBeenCalled();
  });

  it("starts the conversation on the first starter and sends it there", async () => {
    // An unfinished draft does not have to be dismissed first.
    mocked.listKbBuilderSessions.mockResolvedValue([session({ session_id: "s-old" })]);
    mocked.createKbBuilderSession.mockResolvedValue({ session_id: "s-new", builder_agent_id: "a", runtime_id: "rt-1" });
    const adapter = mount(makeAdapter("/acme/kb/new"));

    await screen.findByRole("button", { name: /You have 1 unfinished creation/ });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Engineering knowledge base/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Engineering knowledge base/ }));

    await waitFor(() =>
      expect(mocked.createKbBuilderSession).toHaveBeenCalledWith({
        mode: "create",
        knowledge_base_id: undefined,
        schema_mode: "custom",
        runtime_id: "rt-1",
        model: undefined,
      }),
    );
    await waitFor(() => expect(h.send).toHaveBeenCalledWith("Help me create a knowledge base for engineers", undefined, "s-new"));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/new/s-new?runtime=rt-1");
    expect(useKbBuilderRuntimeStore.getState().byKey[kbBuilderRuntimeKey("ws-1", "user-1")]).toBe("rt-1");
  });

  it("starts the conversation on a composer send and clears the composer", async () => {
    let resolveStart: (value: { session_id: string; builder_agent_id: string; runtime_id: string }) => void = () => {};
    mocked.createKbBuilderSession.mockReturnValue(new Promise((resolve) => (resolveStart = resolve)));
    mount(makeAdapter("/acme/kb/new"));

    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "给研发看" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Starting the builder on Claude…")).toBeInTheDocument();
    expect(screen.getByText("给研发看")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(composer).toBeDisabled();

    await act(async () => resolveStart({ session_id: "s-new", builder_agent_id: "a", runtime_id: "rt-1" }));
    expect(h.send).toHaveBeenCalledWith("给研发看", undefined, "s-new");
  });

  it("starts a configuration with the base's schema mode", async () => {
    mocked.getKnowledgeBase.mockResolvedValue({ ...BASE, schema_mode: "custom" });
    mocked.createKbBuilderSession.mockResolvedValue({ session_id: "s-cfg", builder_agent_id: "a", runtime_id: "rt-1" });
    const adapter = mount(makeAdapter("/acme/kb/team/config"));

    await screen.findByDisplayValue("团队知识库");
    const question = await screen.findByRole("button", { name: /Who reads this knowledge base/ });
    await waitFor(() => expect(question).toBeEnabled());
    fireEvent.click(question);

    await waitFor(() =>
      expect(mocked.createKbBuilderSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "config", knowledge_base_id: "kb-1", schema_mode: "custom" }),
      ),
    );
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team/config/s-cfg?runtime=rt-1");
  });

  it("opens on the runtime used last when it is online", async () => {
    mocked.listRuntimes.mockResolvedValue([RUNTIME, RUNTIME_2]);
    useKbBuilderRuntimeStore.getState().setLastRuntime("ws-1", "user-1", "rt-2");
    mount(makeAdapter("/acme/kb/new"));

    await waitFor(async () => expect(await runtimeTrigger()).toHaveAccessibleName("Runtime: Codex"));
  });

  it("offers the single unfinished creation directly", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([session({ session_id: "s-old" })]);
    const adapter = mount(makeAdapter("/acme/kb/new"));

    fireEvent.click(await screen.findByRole("button", { name: /You have 1 unfinished creation/ }));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/new/s-old");
    expect(mocked.listKbBuilderSessions).toHaveBeenCalledWith({ mode: "create", kb: undefined });
  });

  it("opens the picker when there are several unfinished creations", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([session({ session_id: "s-a" }), session({ session_id: "s-b" })]);
    const adapter = mount(makeAdapter("/acme/kb/new"));

    fireEvent.click(await screen.findByRole("button", { name: /You have 2 unfinished creations/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Creation drafts");
    expect(adapter.replace).not.toHaveBeenCalled();
  });
});

describe("KbBuilderPage · runtime states", () => {
  it("without a runtime, disables the chat and still creates from the form", async () => {
    mocked.listRuntimes.mockResolvedValue([]);
    mocked.createKnowledgeBase.mockResolvedValue({ ...BASE, id: "kb-9", slug: "manual", mention: "" });
    const adapter = mount(makeAdapter("/acme/kb/new"));

    expect(await screen.findByText("No runtime available yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect runtime" })).toHaveAttribute("href", "/acme/runtimes");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Connect a runtime to chat");
    expect(screen.getByRole("button", { name: /^Engineering knowledge base/ })).toBeDisabled();
    expect(screen.getByText("You can create without the conversation")).toBeInTheDocument();
    // The runtime pill stays usable: it is the way to connect one.
    const trigger = await runtimeTrigger();
    expect(trigger).toHaveAccessibleName("Runtime: No runtime available");
    expect(trigger).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "手填的库" } });
    fireEvent.change(screen.getByLabelText("Directory name"), { target: { value: "manual" } });
    fireEvent.change(screen.getByLabelText("Schema"), { target: { value: "# Rules" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocked.createKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({ name: "手填的库", slug: "manual" })),
    );
    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/manual?welcome=1"));
    expect(mocked.createKbBuilderSession).not.toHaveBeenCalled();
    expect(mocked.setChatSessionArchived).not.toHaveBeenCalled();
    expect(mocked.saveKbBuilderDraft).not.toHaveBeenCalled();
  });

  it("saves a configuration without a runtime", async () => {
    mocked.listRuntimes.mockResolvedValue([]);
    mocked.updateKnowledgeBase.mockResolvedValue({ ...BASE, mention: "" });
    mount(makeAdapter("/acme/kb/team/config"));

    await screen.findByDisplayValue("团队知识库");
    expect(await screen.findByText("You can save without the conversation")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "# 新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.updateKnowledgeBase).toHaveBeenCalledWith("team", expect.objectContaining({ purpose: "# 新目标" })),
    );
    expect(mocked.createKbBuilderSession).not.toHaveBeenCalled();
  });

  it("shows an offline runtime and keeps the chat closed", async () => {
    mocked.listRuntimes.mockResolvedValue([makeRuntime({ status: "offline" })]);
    mount(makeAdapter("/acme/kb/new"));

    expect(await screen.findByText("Claude is offline")).toBeInTheDocument();
    expect(screen.getByText(/Open Marvis on laptop/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Runtime offline. Switch to an online runtime to continue",
    );
    expect(screen.getByText("You can create without the conversation")).toBeInTheDocument();
  });

  it("says so when the runtime goes offline mid-conversation and keeps the form", async () => {
    h.messages = [reply("好的")];
    mocked.listRuntimes.mockResolvedValue([makeRuntime({ status: "offline" })]);
    mocked.listKbBuilderSessions.mockResolvedValue([session()]);
    mount(makeAdapter("/acme/kb/new/s-1"));

    expect(await screen.findByText("The runtime just went offline")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });

  it("keeps the message when the start fails and resends it on another runtime", async () => {
    mocked.listRuntimes.mockResolvedValue([RUNTIME, RUNTIME_2]);
    mocked.createKbBuilderSession
      .mockRejectedValueOnce(new ApiError("runtime offline", 409, "Conflict"))
      .mockResolvedValueOnce({ session_id: "s-new", builder_agent_id: "a", runtime_id: "rt-2" });
    const adapter = mount(makeAdapter("/acme/kb/new"));

    const starter = await screen.findByRole("button", { name: /^Engineering knowledge base/ });
    await waitFor(() => expect(starter).toBeEnabled());
    fireEvent.click(starter);

    expect(await screen.findByText("The builder could not start")).toBeInTheDocument();
    expect(screen.getByText("Help me create a knowledge base for engineers")).toBeInTheDocument();
    expect(h.send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));

    await waitFor(() =>
      expect(mocked.createKbBuilderSession).toHaveBeenLastCalledWith(expect.objectContaining({ runtime_id: "rt-2" })),
    );
    await waitFor(() => expect(h.send).toHaveBeenCalledWith("Help me create a knowledge base for engineers", undefined, "s-new"));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/new/s-new?runtime=rt-2");
  });

  it("groups the runtimes and locks the ones that cannot be picked", async () => {
    mocked.listRuntimes.mockResolvedValue([
      RUNTIME,
      makeRuntime({ id: "rt-off", name: "Gemini", status: "offline" }),
      makeRuntime({ id: "rt-locked", name: "Qoder", owner_id: "user-2", visibility: "private" }),
    ]);
    mocked.listMembers.mockResolvedValue([
      { user_id: "user-1", role: "member", name: "Me" },
      { user_id: "user-2", role: "member", name: "马安" },
    ] as never);
    mount(makeAdapter("/acme/kb/new"));

    await waitFor(async () => expect(await runtimeTrigger()).toBeEnabled());
    fireEvent.click(await runtimeTrigger());

    const mine = await screen.findByRole("group", { name: "Mine" });
    expect(within(mine).getByRole("option", { name: /Claude/ })).toHaveAttribute("aria-selected", "true");
    expect(within(mine).getByRole("option", { name: /Gemini/ })).toHaveAttribute("aria-disabled", "true");
    const others = screen.getByRole("group", { name: "Others'" });
    const locked = within(others).getByRole("option", { name: /Qoder/ });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Connect a new runtime" })).toHaveAttribute("href", "/acme/runtimes");

    fireEvent.click(locked);
    expect(await runtimeTrigger()).toHaveAccessibleName("Runtime: Claude");
  });
});

describe("KbBuilderPage · narrow layout", () => {
  // jsdom has no layout: report every observed element at phone width.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() {
          this.callback([], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("switches between chat and configuration, keeping the composer clear of the chat launcher", async () => {
    mount(makeAdapter("/acme/kb/new"));

    const chat = await screen.findByRole("tabpanel", { name: "Chat" });
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
    expect(within(chat).getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    expect(chat).toHaveClass("pb-chat-launcher");
    expect(screen.queryByLabelText("Name")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const config = screen.getByRole("tabpanel", { name: "Configuration" });
    expect(within(config).getByLabelText("Name")).toBeInTheDocument();
    expect(config).not.toHaveClass("pb-chat-launcher");
  });
});

describe("KbBuilderPage · access", () => {
  it("shows a notice instead of the builder to a member who cannot configure", async () => {
    mocked.getKnowledgeBase.mockResolvedValue({ ...BASE, created_by: "user-9" });
    const adapter = mount(makeAdapter("/acme/kb/team/config"));

    expect(await screen.findByText("You cannot configure this knowledge base")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the knowledge base" }));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team");
  });

  it("lets a workspace admin configure someone else's base", async () => {
    mocked.getKnowledgeBase.mockResolvedValue({ ...BASE, created_by: "user-9" });
    mocked.listMembers.mockResolvedValue([{ user_id: "user-1", role: "admin", name: "Me" }] as never);
    mount(makeAdapter("/acme/kb/team/config"));

    expect(await screen.findByDisplayValue("团队知识库")).toBeInTheDocument();
    expect(screen.queryByText("You cannot configure this knowledge base")).toBeNull();
  });
});

describe("KbBuilderPage · create conversation", () => {
  const draftReply = reply(
    '好的，起草了。\n<kb_draft>{"name":"支付排障手册","slug":"pay-troubleshoot","description":"支付排障。","purpose":"# 目标\\n\\n读者：研发。","schema":"# Ignored"}</kb_draft>',
  );

  it.each([
    ["Engineering knowledge base", "Help me create a knowledge base for engineers"],
    ["Agent team memory", "Help me create a knowledge base that serves as our agent team's memory"],
    ["Something else", "Help me create a knowledge base"],
  ])("shows the %s starter and sends its message", async (title, message) => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    const starter = await screen.findByRole("button", { name: new RegExp(`^${title}`) });
    await waitFor(() => expect(starter).toBeEnabled());
    fireEvent.click(starter);
    expect(h.send).toHaveBeenCalledWith(message, undefined);
  });

  it("offers six starters", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    await screen.findByRole("button", { name: /Engineering knowledge base/ });
    for (const title of ["Testing knowledge base", "Product knowledge base", "Team knowledge base", "Agent team memory", "Something else"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${title}`) })).toBeInTheDocument();
    }
  });

  it("fills the form from the builder reply, including its custom schema, and creates", async () => {
    h.messages = [draftReply];
    mocked.listKbBuilderSessions.mockResolvedValue([session()]);
    mocked.createKnowledgeBase.mockResolvedValue({ ...BASE, id: "kb-9", slug: "pay-troubleshoot", mention: "" });
    const adapter = mount(makeAdapter("/acme/kb/new/s-1"));

    expect(await screen.findByDisplayValue("支付排障手册")).toBeInTheDocument();
    expect(screen.getByLabelText("Directory name")).toHaveValue("pay-troubleshoot");
    expect(screen.getByLabelText("Purpose")).toHaveValue("# 目标\n\n读者：研发。");
    expect(screen.getAllByText("Just updated")).toHaveLength(2);
    // A new knowledge base starts on a custom schema, so the builder's one applies.
    const schema = screen.getByLabelText("Schema");
    expect(schema).toHaveValue("# Ignored");
    expect(schema).not.toHaveAttribute("readonly");
    expect(within(screen.getByRole("list", { name: "transcript" })).getByText("好的，起草了。")).toBeInTheDocument();

    // The configuration autosaves, with the applied reply.
    await waitFor(
      () =>
        expect(mocked.saveKbBuilderDraft).toHaveBeenCalledWith(
          "s-1",
          expect.objectContaining({ name: "支付排障手册", schema_mode: "custom", schema: "# Ignored", applied_message_id: "m-1" }),
        ),
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(mocked.createKnowledgeBase).toHaveBeenCalledWith({
        name: "支付排障手册",
        slug: "pay-troubleshoot",
        description: "支付排障。",
        purpose: "# 目标\n\n读者：研发。",
        schema_mode: "custom",
        schema: "# Ignored",
      }),
    );
    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/pay-troubleshoot?welcome=1"));
    expect(mocked.setChatSessionArchived).toHaveBeenCalledWith("s-1", true);
  });

  it("goes to the new knowledge base even though archiving makes the conversation missing", async () => {
    h.messages = [draftReply];
    mocked.listKbBuilderSessions.mockResolvedValue([session()]);
    mocked.createKnowledgeBase.mockResolvedValue({ ...BASE, id: "kb-9", slug: "pay-troubleshoot", mention: "" });
    // Archiving retires the conversation, so the builder then reports it missing.
    mocked.setChatSessionArchived.mockImplementation(async () => {
      h.missing = true;
      return {} as Awaited<ReturnType<typeof api.setChatSessionArchived>>;
    });
    const adapter = mount(makeAdapter("/acme/kb/new/s-1"));

    await screen.findByDisplayValue("支付排障手册");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/pay-troubleshoot?welcome=1"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.replace).not.toHaveBeenCalledWith("/acme/kb/new");
  });

  it("restores a saved configuration instead of replaying the applied reply", async () => {
    h.messages = [draftReply];
    mocked.listKbBuilderSessions.mockResolvedValue([
      session({
        draft: {
          name: "手改的名字",
          slug: "mine",
          description: "",
          purpose: "",
          schema_mode: "custom",
          schema: "# Mine",
          applied_message_id: "m-1",
        },
      }),
    ]);
    mount(makeAdapter("/acme/kb/new/s-1"));

    expect(await screen.findByDisplayValue("手改的名字")).toBeInTheDocument();
    expect(screen.getByLabelText("Schema")).toHaveValue("# Mine");
    expect(screen.getByLabelText("Schema")).not.toHaveAttribute("readonly");
  });

  it("starts on an empty custom schema with the default one as its example", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    const schema = await screen.findByLabelText("Schema");
    await waitFor(() => expect(schema).toHaveAttribute("placeholder", DEFAULT_SCHEMA));
    expect(schema).toHaveValue("");
    expect(schema).not.toHaveAttribute("readonly");
    fireEvent.change(schema, { target: { value: "# Team rules" } });

    fireEvent.click(screen.getByRole("tab", { name: "Default" }));
    expect(screen.getByLabelText("Schema")).toHaveValue(DEFAULT_SCHEMA);
    expect(screen.getByLabelText("Schema")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
    expect(screen.getByLabelText("Schema")).toHaveValue("# Team rules");
  });

  it("reports a taken slug and keeps the form", async () => {
    h.messages = [draftReply];
    mocked.listKbBuilderSessions.mockResolvedValue([session()]);
    mocked.createKnowledgeBase.mockRejectedValue(new ApiError("exists", 409, "Conflict"));
    const adapter = mount(makeAdapter("/acme/kb/new/s-1"));

    await screen.findByDisplayValue("支付排障手册");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This directory name is already used in the workspace");
    expect(adapter.replace).not.toHaveBeenCalled();
  });

  it("asks before discarding and leaves once the server accepted", async () => {
    const adapter = mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    fireEvent.click(await screen.findByRole("button", { name: "Discard creation" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("The conversation and the configuration on the right will be deleted permanently.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard creation" }));

    await waitFor(() => expect(h.destroy).toHaveBeenCalled());
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb");
  });

  it("opens the purpose in the enlarged editor and writes back on Done", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    fireEvent.click(await screen.findByRole("button", { name: "Expand to edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Purpose" }), { target: { value: "# 目标\n\n新的" } });
    expect(within(dialog).getByTestId("kb-markdown-preview")).toHaveTextContent("新的");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.getByLabelText("Purpose")).toHaveValue("# 目标\n\n新的"));
  });

  it("shows the default schema enlarged as a read-only preview", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    await waitFor(() => expect(screen.getByLabelText("Schema")).toHaveAttribute("placeholder", DEFAULT_SCHEMA));
    fireEvent.click(screen.getByRole("tab", { name: "Default" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand to view" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText("Default · read-only")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });
});

describe("KbBuilderPage · configuration", () => {
  it("starts from the current configuration, marks edits unsaved and saves", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([session({ mode: "config", knowledge_base_id: "kb-1" })]);
    mocked.updateKnowledgeBase.mockResolvedValue({ ...BASE, mention: "" });
    const adapter = mount(makeAdapter("/acme/kb/team/config/s-1"));

    expect(await screen.findByDisplayValue("团队知识库")).toBeInTheDocument();
    expect(screen.queryByLabelText("Directory name")).toBeNull();
    expect(screen.getByLabelText("Schema")).toHaveValue("# Schema (created)");
    expect(screen.getByRole("button", { name: /Who reads this knowledge base/ })).toBeInTheDocument();
    expect(mocked.listKbBuilderSessions).toHaveBeenCalledWith({ mode: "config", kb: "team" });

    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "# 目标\n\n读者：研发。" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.updateKnowledgeBase).toHaveBeenCalledWith("team", {
        name: "团队知识库",
        description: "订单与支付",
        purpose: "# 目标\n\n读者：研发。",
        schema_mode: "default",
        base_updated_at: "2026-10-25T14:20:11Z",
      }),
    );
    // Saving keeps the conversation open on the configuration page.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved"));
    expect(adapter.replace).not.toHaveBeenCalled();
    expect(mocked.setChatSessionArchived).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Purpose")).toHaveValue("# 目标\n\n读者：研发。");
  });

  it("lists only the configuration conversations with unsaved changes", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([
      session({ session_id: "s-saved", mode: "config", knowledge_base_id: "kb-1", title: "Saved one", draft: null }),
      session({
        session_id: "s-open",
        mode: "config",
        knowledge_base_id: "kb-1",
        title: "Open one",
        draft: { name: "团队知识库", slug: "team", description: "订单与支付", purpose: "改过的目标", schema_mode: "default", schema: "", applied_message_id: null },
      }),
    ]);
    mount(makeAdapter("/acme/kb/team/config"));

    await waitFor(() => expect(mocked.listKbBuilderSessions).toHaveBeenCalled());
    expect(await screen.findByText(/1 unfinished/)).toBeInTheDocument();
  });

  it("keeps the edits when someone else saved first", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([session({ mode: "config", knowledge_base_id: "kb-1" })]);
    mocked.updateKnowledgeBase.mockRejectedValue(new ApiError("stale", 409, "Conflict"));
    const adapter = mount(makeAdapter("/acme/kb/team/config/s-1"));

    await screen.findByDisplayValue("团队知识库");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else saved this configuration after you opened it");
    expect(adapter.replace).not.toHaveBeenCalled();
  });
});
