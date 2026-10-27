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
import { queueFollowUpsBehindRun } from "./run-follow-up-queue";

const CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;

/**
 * The follow-up conversation of one run: the run's chat session, sent,
 * stopped and queued exactly like the chat page. A run without a session yet
 * gets one from `ensureSession` right before its first send.
 *
 * `draftKey` is the composer's draft slot; restores of a stopped turn are
 * addressed to it so they land in this page's composer.
 *
 * While `runInProgress`, the server holds every turn until the run ends, so
 * they all read as queued, including the one that would otherwise be the
 * turn in progress.
 */
export function useAutopilotRunConversation(
  sessionId: string | null,
  ensureSession: () => Promise<string>,
  draftKey: string,
  runInProgress: boolean,
) {
  const { t } = useT("chat");
  const qc = useQueryClient();
  const activeSessionId = sessionId ?? "";
  const {
    data,
    isLoading: messagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(chatMessagesPageOptions(activeSessionId));
  const { data: serverPendingTask, isLoading: pendingLoading } = useQuery(pendingChatTaskOptions(activeSessionId));

  const pages = useMemo(() => (activeSessionId ? data?.pages ?? [] : []), [activeSessionId, data]);
  const allMessages = useMemo(() => [...pages].reverse().flatMap((page) => page.messages), [pages]);
  const pendingTask = useMemo(
    () => (runInProgress ? queueFollowUpsBehindRun(serverPendingTask, allMessages) : serverPendingTask),
    [runInProgress, serverPendingTask, allMessages],
  );
  const messages = useMemo<ChatMessage[]>(
    () => hideQueuedChatMessages(allMessages, pendingTask),
    [allMessages, pendingTask],
  );
  const olderMessageCount = pages.slice(1).reduce((count, page) => count + page.messages.length, 0);

  const appForeground = useAppForeground();
  const { restoreDraftRequest, enqueueLocalRestore, handleRestoreDraftApplied } = useChatDraftRestore(
    sessionId,
    appForeground,
  );
  const taskActions = useChatTaskActions(sessionId, enqueueLocalRestore);
  const pendingTaskId = pendingTask?.task_id ?? null;
  // Clearing keeps the server's head turn; while the run holds it, it is one
  // of the queued rows, so clearing removes it too.
  const heldHeadId = pendingTask === serverPendingTask ? null : serverPendingTask?.task_id ?? null;
  const { handleClearQueuedTasks, handleRemoveQueuedTask } = taskActions;
  const clearQueue = useCallback(async () => {
    await handleClearQueuedTasks();
    if (heldHeadId) await handleRemoveQueuedTask(heldHeadId);
  }, [handleClearQueuedTasks, handleRemoveQueuedTask, heldHeadId]);
  const queue = useMemo(() => ({ ...taskActions, handleClearQueuedTasks: clearQueue }), [taskActions, clearQueue]);

  const send = useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
      draftAttachments: Attachment[] = [],
    ): Promise<boolean> => {
      if (!content.trim()) return false;
      if (pendingTaskId && pendingTask?.supports_queue !== true) return false;

      let targetSessionId = sessionId;
      if (!targetSessionId) {
        try {
          targetSessionId = await ensureSession();
        } catch {
          toast.error(t(($) => $.input.send_failed_toast));
          return false;
        }
      }

      let result;
      try {
        result = await api.sendChatMessage(targetSessionId, content, attachmentIds);
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
        targetSessionId,
        {
          id: result.message_id,
          chat_session_id: targetSessionId,
          role: "user",
          content,
          task_id: result.task_id,
          created_at: result.created_at,
          attachments: draftAttachments,
        },
        { seedIfMissing: true },
      );
      seedAcceptedPendingTask(qc, targetSessionId, {
        task_id: result.task_id,
        created_at: result.created_at,
        message_id: result.message_id,
        content,
        supports_queue: result.supports_queue,
        queued: result.queued,
      });
      commitInput?.();
      void qc.invalidateQueries({ queryKey: chatKeys.messages(targetSessionId) });
      void qc.invalidateQueries({ queryKey: chatKeys.messagesPage(targetSessionId) });

      return true;
    },
    [sessionId, ensureSession, pendingTaskId, pendingTask?.supports_queue, qc, t],
  );

  const stop = useCallback(() => {
    if (!pendingTaskId || !sessionId) return;

    return taskActions.cancelChatTask(pendingTaskId, sessionId, {
      restoreDraftToInput: true,
      source: "autopilot-run",
    });
  }, [pendingTaskId, sessionId, taskActions]);

  // Restores are addressed to a chat session; this composer's draft slot is
  // the run's, and the page only ever shows the run's one session.
  const restore = useMemo(
    () => (restoreDraftRequest ? { ...restoreDraftRequest, sessionId: draftKey } : null),
    [restoreDraftRequest, draftKey],
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
    queue,
  };
}
