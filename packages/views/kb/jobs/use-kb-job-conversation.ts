"use client";

import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, dispatchReasonCode } from "@marvis/core/api";
import { chatKeys, chatMessagesPageOptions, pendingChatTaskOptions } from "@marvis/core/chat/queries";
import { upsertChatMessageToCaches } from "@marvis/core/chat/message-cache";
import { hideQueuedChatMessages } from "@marvis/core/chat/pending";
import type { Attachment, ChatMessage } from "@marvis/core/types";
import { useAppForeground } from "../../common/use-app-foreground";
import { useChatDraftRestore } from "../../chat/components/use-chat-draft-restore";
import { useChatTaskActions } from "../../chat/components/use-chat-task-actions";
import { seedAcceptedPendingTask } from "../../chat/components/use-chat-controller";
import { useT } from "../../i18n";
import { memberPartOfJobMessage, reviewHandoffNumber } from "./kb-job-state";

const CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;

/**
 * The conversation of one job: the job's chat session, sent, stopped and
 * queued exactly like the chat page (designs 9.11, 9.16). The first message
 * shows only what the member typed and a review hand-off shows a short line;
 * the server-written prompt goes to the agent.
 */
export function useKbJobConversation(sessionId: string) {
  const { t } = useT("chat");
  const { t: tKb } = useT("kb");
  const qc = useQueryClient();
  const {
    data,
    isLoading: messagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(chatMessagesPageOptions(sessionId));
  const { data: serverPendingTask, isLoading: pendingLoading } = useQuery(pendingChatTaskOptions(sessionId));

  const displayContent = useCallback(
    (content: string) => {
      const number = reviewHandoffNumber(content);

      return number === null ? memberPartOfJobMessage(content) : tKb(($) => $.job.feedback.chat_message, { number });
    },
    [tKb],
  );
  const pendingTask = useMemo(
    () =>
      serverPendingTask?.queued_tasks
        ? {
            ...serverPendingTask,
            queued_tasks: serverPendingTask.queued_tasks.map((task) =>
              task.content ? { ...task, content: displayContent(task.content) } : task,
            ),
          }
        : serverPendingTask,
    [serverPendingTask, displayContent],
  );

  const pages = useMemo(() => (sessionId ? data?.pages ?? [] : []), [sessionId, data]);
  const messages = useMemo<ChatMessage[]>(() => {
    const all = [...pages].reverse().flatMap((page) => page.messages);
    return hideQueuedChatMessages(all, pendingTask).map((message) =>
      message.role === "user" ? { ...message, content: displayContent(message.content) } : message,
    );
  }, [pages, pendingTask, displayContent]);
  const olderMessageCount = pages.slice(1).reduce((count, page) => count + page.messages.length, 0);

  const appForeground = useAppForeground();
  const { restoreDraftRequest, enqueueLocalRestore, handleRestoreDraftApplied } = useChatDraftRestore(
    sessionId || null,
    appForeground,
  );
  const taskActions = useChatTaskActions(sessionId || null, enqueueLocalRestore);
  const pendingTaskId = pendingTask?.task_id ?? null;

  const send = useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
      draftAttachments: Attachment[] = [],
    ): Promise<boolean> => {
      if (!sessionId || !content.trim()) return false;
      if (pendingTaskId && pendingTask?.supports_queue !== true) return false;

      let result;
      try {
        result = await api.sendChatMessage(sessionId, content, attachmentIds);
      } catch (err) {
        const reason = dispatchReasonCode(err);
        toast.error(
          reason === "invocation_not_allowed"
            ? t(($) => $.input.send_blocked_toast)
            : reason === "agent_runtime_required"
              ? t(($) => $.input.runtime_required_toast)
              : t(($) => $.input.send_failed_toast),
        );
        return false;
      }

      upsertChatMessageToCaches(
        qc,
        sessionId,
        {
          id: result.message_id,
          chat_session_id: sessionId,
          role: "user",
          content,
          task_id: result.task_id,
          created_at: result.created_at,
          attachments: draftAttachments,
        },
        { seedIfMissing: true },
      );
      seedAcceptedPendingTask(qc, sessionId, {
        task_id: result.task_id,
        created_at: result.created_at,
        message_id: result.message_id,
        content,
        supports_queue: result.supports_queue,
        queued: result.queued,
      });
      commitInput?.();
      void qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
      void qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });

      return true;
    },
    [sessionId, pendingTaskId, pendingTask?.supports_queue, qc, t],
  );

  const stop = useCallback(() => {
    if (!pendingTaskId || !sessionId) return;

    return taskActions.cancelChatTask(pendingTaskId, sessionId, {
      restoreDraftToInput: true,
      source: "kb-job",
    });
  }, [pendingTaskId, sessionId, taskActions]);

  // A stopped turn restores the whole server-written message; the composer
  // gets what the chat showed for it.
  const restore = useMemo(
    () => (restoreDraftRequest ? { ...restoreDraftRequest, content: displayContent(restoreDraftRequest.content) } : null),
    [restoreDraftRequest, displayContent],
  );

  return {
    messages,
    loading: !!sessionId && (messagesLoading || pendingLoading),
    pendingTask,
    running: !!pendingTaskId,
    firstItemIndex: messages.length > 0 ? CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX - olderMessageCount : 0,
    hasOlderMessages: !!hasNextPage,
    isFetchingOlderMessages: isFetchingNextPage,
    fetchOlderMessages: () => void fetchNextPage(),
    send,
    stop,
    restoreDraftRequest: restore,
    handleRestoreDraftApplied,
    queue: taskActions,
  };
}
