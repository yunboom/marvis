import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "@marvis/core/api";
import { EMPTY_AGENT_DRAFT } from "@marvis/core/agents";
import type { ChatMessage, KbBuilderSession, KnowledgeBaseDetail, RuntimeDevice } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbBuilderPage } from "./kb-builder-page";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
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
    missing: false,
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

vi.mock("../../agents/create/use-create-agent-form", () => ({
  useCreateAgentForm: () => {
    const [draft, setDraft] = useState({ ...EMPTY_AGENT_DRAFT, runtimeId: "rt-1" });
    return {
      draft,
      setDraft,
      selectedRuntime: RUNTIME,
      runtimes: [RUNTIME],
      runtimesLoading: false,
      members: [],
      currentUserId: "user-1",
    };
  },
}));

// The conversation column renders its own chat; here it shows the empty
// state the page hands it, or the (already decoded) messages.
vi.mock("../../agents/create/builder-conversation", () => ({
  BuilderConversation: ({ messages, emptyState }: { messages: ChatMessage[]; emptyState: ReactNode }) =>
    messages.length === 0 ? (
      <div>{emptyState}</div>
    ) : (
      <ul aria-label="transcript">
        {messages.map((message) => (
          <li key={message.id}>{message.content}</li>
        ))}
      </ul>
    ),
  BuilderSetup: ({ title, banner, onStart }: { title: string; banner: ReactNode; onStart: () => void }) => (
    <div>
      {banner}
      <h2>{title}</h2>
      <button type="button" onClick={onStart}>
        Start
      </button>
    </div>
  ),
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

const RUNTIME = {
  id: "rt-1",
  name: "Claude",
  status: "online",
  owner_id: "user-1",
  provider: "claude",
  visibility: "private",
} as unknown as RuntimeDevice;

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
  mocked.listKbBuilderSessions.mockResolvedValue([]);
  mocked.getKnowledgeBaseTemplates.mockResolvedValue({ default_schema: DEFAULT_SCHEMA, purpose_template: "# Purpose" });
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.listRuntimes.mockResolvedValue([RUNTIME]);
  mocked.saveKbBuilderDraft.mockResolvedValue(undefined);
  mocked.setChatSessionArchived.mockResolvedValue({} as never);
});

describe("KbBuilderPage · runtime step", () => {
  it("starts a create conversation and opens it on its runtime", async () => {
    mocked.createKbBuilderSession.mockResolvedValue({ session_id: "s-new", builder_agent_id: "a", runtime_id: "rt-1" });
    const adapter = mount(makeAdapter("/acme/kb/new"));

    expect(await screen.findByRole("heading", { name: "Create a knowledge base through conversation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(mocked.createKbBuilderSession).toHaveBeenCalledWith({
        mode: "create",
        knowledge_base_id: undefined,
        schema_mode: "default",
        runtime_id: "rt-1",
        model: undefined,
      }),
    );
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/new/s-new?runtime=rt-1");
  });

  it("offers the single unfinished creation directly", async () => {
    mocked.listKbBuilderSessions.mockResolvedValue([session({ session_id: "s-old" })]);
    const adapter = mount(makeAdapter("/acme/kb/new"));

    fireEvent.click(await screen.findByRole("button", { name: /You have 1 unfinished creation/ }));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/new/s-old");
    expect(mocked.listKbBuilderSessions).toHaveBeenCalledWith({ mode: "create", kb: undefined });
  });

  it("starts a configuration with the base's schema mode", async () => {
    mocked.getKnowledgeBase.mockResolvedValue({ ...BASE, schema_mode: "custom" });
    mocked.createKbBuilderSession.mockResolvedValue({ session_id: "s-cfg", builder_agent_id: "a", runtime_id: "rt-1" });
    const adapter = mount(makeAdapter("/acme/kb/team/config"));

    expect(await screen.findByRole("heading", { name: "Configure the knowledge base through conversation" })).toBeInTheDocument();
    await screen.findByText("团队知识库");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(mocked.createKbBuilderSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "config", knowledge_base_id: "kb-1", schema_mode: "custom" }),
      ),
    );
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team/config/s-cfg?runtime=rt-1");
  });
});

describe("KbBuilderPage · create conversation", () => {
  const draftReply = reply(
    '好的，起草了。\n<kb_draft>{"name":"支付排障手册","slug":"pay-troubleshoot","description":"支付排障。","purpose":"# 目标\\n\\n读者：研发。","schema":"# Ignored"}</kb_draft>',
  );

  it("shows the opening starters and sends one", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    fireEvent.click(await screen.findByRole("button", { name: /Engineering knowledge base/ }));
    expect(h.send).toHaveBeenCalledWith(
      "Engineering knowledge base: System architecture, services and interfaces, runbooks, technical decisions",
    );
  });

  it("fills the form from the builder reply, keeps the default schema read-only and creates", async () => {
    h.messages = [draftReply];
    mocked.listKbBuilderSessions.mockResolvedValue([session()]);
    mocked.createKnowledgeBase.mockResolvedValue({ ...BASE, id: "kb-9", slug: "pay-troubleshoot", mention: "" });
    const adapter = mount(makeAdapter("/acme/kb/new/s-1"));

    expect(await screen.findByDisplayValue("支付排障手册")).toBeInTheDocument();
    expect(screen.getByLabelText("Directory name")).toHaveValue("pay-troubleshoot");
    expect(screen.getByLabelText("Purpose")).toHaveValue("# 目标\n\n读者：研发。");
    expect(screen.getByText("Just updated")).toBeInTheDocument();
    // The builder's schema is ignored in the default mode.
    const schema = screen.getByLabelText("Schema");
    expect(schema).toHaveValue(DEFAULT_SCHEMA);
    expect(schema).toHaveAttribute("readonly");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "transcript" })).getByText("好的，起草了。")).toBeInTheDocument();

    // The configuration autosaves, with the applied reply.
    await waitFor(
      () =>
        expect(mocked.saveKbBuilderDraft).toHaveBeenCalledWith(
          "s-1",
          expect.objectContaining({ name: "支付排障手册", schema_mode: "default", schema: "", applied_message_id: "m-1" }),
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
        schema_mode: "default",
      }),
    );
    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/pay-troubleshoot?welcome=1"));
    expect(mocked.setChatSessionArchived).toHaveBeenCalledWith("s-1", true);
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

  it("switches to a custom schema seeded from the default one", async () => {
    mount(makeAdapter("/acme/kb/new/s-1", "runtime=rt-1"));

    await waitFor(() => expect(screen.getByLabelText("Schema")).toHaveValue(DEFAULT_SCHEMA));
    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
    expect(screen.getByLabelText("Schema")).not.toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("Schema"), { target: { value: "# Team rules" } });

    fireEvent.click(screen.getByRole("tab", { name: "Default" }));
    expect(screen.getByLabelText("Schema")).toHaveValue(DEFAULT_SCHEMA);
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
    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team"));
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
