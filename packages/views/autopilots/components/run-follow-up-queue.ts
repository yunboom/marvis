import type { ChatMessage, ChatPendingTask, ChatQueuedTask } from "@marvis/core/types";

/**
 * While the run itself executes, every follow-up waits for it: the server
 * holds the conversation's turns until the run ends. Present the head turn
 * as the first queued message instead of a reply in progress, so the queue
 * shows everything that is waiting and the transcript shows none of it.
 * A head that has already left `queued` is a live turn and stays one.
 */
export function queueFollowUpsBehindRun(
  pending: ChatPendingTask | undefined,
  messages: ChatMessage[],
): ChatPendingTask | undefined {
  if (!pending?.task_id) return pending;
  if (pending.status && pending.status !== "queued") return pending;

  const headMessage = messages.find(
    (message) => message.role === "user" && message.task_id === pending.task_id,
  );
  const head: ChatQueuedTask = {
    task_id: pending.task_id,
    status: pending.status ?? "queued",
    created_at: pending.created_at ?? "",
    ...(headMessage ? { message_id: headMessage.id, content: headMessage.content } : {}),
  };
  const queueSupport = pending.supports_queue === undefined ? {} : { supports_queue: pending.supports_queue };

  return {
    ...queueSupport,
    queued_tasks: [head, ...(pending.queued_tasks ?? []).filter((task) => task.task_id !== head.task_id)],
  };
}
