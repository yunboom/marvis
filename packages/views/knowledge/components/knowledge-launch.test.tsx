// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import enChat from "../../locales/en/chat.json";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge, chat: enChat } };

const messagesRef = vi.hoisted(() => ({ current: [] as unknown[] }));
const apiMock = vi.hoisted(() => ({
  createKnowledgeSession: vi.fn(() => Promise.resolve({ session_id: "s-1", kind: "fix", maintainer_agent_id: "agent-1", carrier_agent_id: "c-1", knowledge_base_id: "kb-1", created_by: "u1", created_at: "" })),
  sendChatMessage: vi.fn(() => Promise.resolve({ message_id: "m-1", task_id: "t-1" })),
  createKnowledgeBase: vi.fn(() => Promise.resolve({ id: "kb-2", slug: "qa", name: "QA lab" })),
}));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/api", () => ({ api: apiMock, ApiError: class extends Error { status = 0; } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@marvis/core/chat/queries", () => ({
  chatKeys: { messages: (id: string) => ["m", id], messagesPage: (id: string) => ["mp", id], pendingTask: (id: string) => ["p", id] },
  chatMessagesOptions: (id: string) => ({ queryKey: ["m", id], queryFn: () => Promise.resolve(messagesRef.current) }),
  pendingChatTaskOptions: (id: string) => ({ queryKey: ["p", id], queryFn: () => Promise.resolve({}) }),
  chatSessionsOptions: () => ({ queryKey: ["sessions"], queryFn: () => Promise.resolve([]) }),
}));
vi.mock("@marvis/core/chat/message-cache", () => ({ upsertChatMessageToCaches: vi.fn() }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgeChangeListOptions: () => ({ queryKey: ["changes"], queryFn: () => Promise.resolve([]) }),
  knowledgeAnnotationListOptions: () => ({ queryKey: ["anns"], queryFn: () => Promise.resolve([]) }),
}));
// The real chat widgets pull in the editor and realtime stack; the launcher only
// needs a list and a composer.
vi.mock("../../chat/components/chat-message-list", () => ({
  ChatMessageList: ({ messages, transformContent }: { messages: { id: string; content: string }[]; transformContent: (s: string) => string }) => (
    <div>{messages.map((m) => <p key={m.id}>{transformContent(m.content)}</p>)}</div>
  ),
  ChatMessageSkeleton: () => null,
}));
vi.mock("../../chat/components/chat-input", () => ({ ChatInput: () => <div data-testid="composer" /> }));

import { useKnowledgeLauncher } from "./knowledge-launch";

const kb = (maintainer: string | null) => ({
  id: "kb-1", workspace_id: "ws-1", name: "Team", slug: "team", description: "", maintainer_agent_id: maintainer,
  created_by: "", page_count: 0, created_at: "", updated_at: "",
});
const agents = [{ id: "agent-1", name: "Marvis", archived_at: null }] as never[];
const annotation = {
  id: "a-1", knowledge_base_id: "kb-1", page_path: "team/wiki/x.md", page_title: "X", quote: "Old claim.", body: "Wrong",
  author_type: "member", author_id: "u1", author_name: "Ana", status: "pending", change_request_id: null, change_number: null,
  anchor_lost: false, created_at: "",
} as const;

function Harness({ maintainer, op }: { maintainer: string | null; op: "fix" | "create" }) {
  const launcher = useKnowledgeLauncher({
    kb: kb(maintainer),
    bases: [kb(maintainer)],
    agents,
    onOpenChange: vi.fn(),
    onOpenAnnotations: vi.fn(),
    onCreated: vi.fn(),
  });

  return (
    <>
      <button type="button" onClick={() => launcher.launch(op === "fix" ? { kind: "fix", annotations: [annotation] } : { kind: "create" })}>
        go
      </button>
      {launcher.dialogs}
    </>
  );
}

function renderHarness(maintainer: string | null, op: "fix" | "create" = "fix") {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness maintainer={maintainer} op={op} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("useKnowledgeLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messagesRef.current = [];
  });

  it("starts a fix session with the maintainer and sends the composed first message", async () => {
    renderHarness("agent-1");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(apiMock.createKnowledgeSession).toHaveBeenCalledWith({ kind: "fix", knowledge_base_id: "kb-1", agent_id: undefined }));
    await waitFor(() => expect(apiMock.sendChatMessage).toHaveBeenCalled());
    const [sessionId, content] = apiMock.sendChatMessage.mock.calls[0] as unknown as [string, string];
    expect(sessionId).toBe("s-1");
    expect(content).toContain("[a-1] team/wiki/x.md: \"Old claim.\" — Wrong");
    expect(content).toContain("Session id: s-1");
    expect(await screen.findByText("Annotation fix")).toBeTruthy();
  });

  it("asks for a maintainer first when the knowledge base has none", async () => {
    renderHarness(null);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("Choose the maintainer agent for Team")).toBeTruthy();
    expect(apiMock.createKnowledgeSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Marvis" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(apiMock.createKnowledgeSession).toHaveBeenCalledWith({ kind: "fix", knowledge_base_id: "kb-1", agent_id: "agent-1" }));
  });

  it("creates a knowledge base from the agent's draft", async () => {
    messagesRef.current = [
      { id: "m-2", chat_session_id: "s-1", role: "assistant", content: 'Here it is.\n<kb_draft>{"name":"QA lab","description":"Test methods","purpose":"For testers"}</kb_draft>', created_at: "" },
    ];
    renderHarness("agent-1", "create");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Marvis" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(apiMock.sendChatMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("Here it is.")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    await waitFor(() => expect(apiMock.createKnowledgeBase).toHaveBeenCalledWith({ name: "QA lab", description: "Test methods", purpose: "For testers" }));
  });
});
