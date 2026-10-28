import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { chatKeys } from "@marvis/core/chat/queries";
import type { ChatMessage, ChatPendingTask } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { useKbJobConversation } from "./use-kb-job-conversation";

vi.mock("@marvis/core/api", () => ({
  dispatchReasonCode: () => null,
  api: { listChatMessagesPage: vi.fn(), getPendingChatTask: vi.fn(), sendChatMessage: vi.fn() },
}));

vi.mock("../../common/use-app-foreground", () => ({ useAppForeground: () => true }));

vi.mock("../../chat/components/use-chat-draft-restore", () => ({
  useChatDraftRestore: () => ({ restoreDraftRequest: null, enqueueLocalRestore: vi.fn(), handleRestoreDraftApplied: vi.fn() }),
}));

vi.mock("../../chat/components/use-chat-task-actions", () => ({ useChatTaskActions: () => ({ cancelChatTask: vi.fn() }) }));

vi.mock("../../chat/components/use-chat-controller", () => ({ seedAcceptedPendingTask: vi.fn() }));

const SESSION = "session-1";

const message = (id: string, role: string, content: string): ChatMessage => ({
  id,
  chat_session_id: SESSION,
  role,
  content,
  task_id: `task-${id}`,
  created_at: "2026-10-27T08:00:00Z",
} as ChatMessage);

function Conversation() {
  const conversation = useKbJobConversation(SESSION);

  return (
    <>
      <ol aria-label="messages">
        {conversation.messages.map((m) => (
          <li key={m.id}>{m.content}</li>
        ))}
      </ol>
      <ol aria-label="queue">
        {(conversation.pendingTask?.queued_tasks ?? []).map((task) => (
          <li key={task.task_id}>{task.content}</li>
        ))}
      </ol>
    </>
  );
}

function renderConversation(messages: ChatMessage[], pending: ChatPendingTask, locale: "en" | "zh-Hans" = "en") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(chatKeys.messagesPage(SESSION), {
    pages: [{ messages, has_more: false, next_cursor: null }],
    pageParams: [null],
  });
  qc.setQueryData(chatKeys.pendingTask(SESSION), pending);

  renderWithI18n(
    <QueryClientProvider client={qc}>
      <Conversation />
    </QueryClientProvider>,
    { locale },
  );
}

describe("useKbJobConversation", () => {
  it("shows every message exactly as it was sent", () => {
    const first = "检查[团队知识库](mention://kb/kb-1)里过期、矛盾或缺失的内容。";
    renderConversation(
      [message("m1", "user", first), message("m2", "assistant", "Done."), message("m3", "user", "处理 #4 的审核意见")],
      {},
      "zh-Hans",
    );

    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([first, "Done.", "处理 #4 的审核意见"]);
  });

  it("shows a queued message as it was sent", () => {
    renderConversation([message("m1", "user", "hello")], {
      task_id: "task-running",
      supports_queue: true,
      queued_tasks: [{ task_id: "task-m2", status: "queued", created_at: "", message_id: "m2", content: "Resolve the review feedback on #4" }],
    });

    expect(screen.getByRole("list", { name: "queue" }).textContent).toBe("Resolve the review feedback on #4");
  });
});
