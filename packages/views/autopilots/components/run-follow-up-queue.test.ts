// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@marvis/core/types";
import { queueFollowUpsBehindRun } from "./run-follow-up-queue";

const userMessage = (id: string, taskId: string, content: string): ChatMessage =>
  ({ id, chat_session_id: "chat-1", role: "user", content, task_id: taskId, created_at: "2026-10-27T03:00:00Z" }) as ChatMessage;

describe("queueFollowUpsBehindRun", () => {
  it("moves the queued head in front of the queue with its message", () => {
    const pending = queueFollowUpsBehindRun(
      {
        task_id: "t-1",
        status: "queued",
        created_at: "2026-10-27T03:00:00Z",
        supports_queue: true,
        queued_tasks: [{ task_id: "t-2", status: "queued", created_at: "2026-10-27T03:01:00Z", message_id: "m-2", content: "Second" }],
      },
      [userMessage("m-1", "t-1", "First")],
    );

    expect(pending).toEqual({
      supports_queue: true,
      queued_tasks: [
        { task_id: "t-1", status: "queued", created_at: "2026-10-27T03:00:00Z", message_id: "m-1", content: "First" },
        { task_id: "t-2", status: "queued", created_at: "2026-10-27T03:01:00Z", message_id: "m-2", content: "Second" },
      ],
    });
  });

  it("keeps a head that already started as the turn in progress", () => {
    const running = { task_id: "t-1", status: "running", supports_queue: true };

    expect(queueFollowUpsBehindRun(running, [userMessage("m-1", "t-1", "First")])).toBe(running);
  });

  it("leaves a conversation with nothing pending alone", () => {
    expect(queueFollowUpsBehindRun(undefined, [])).toBeUndefined();
    expect(queueFollowUpsBehindRun({}, [])).toEqual({});
  });
});
