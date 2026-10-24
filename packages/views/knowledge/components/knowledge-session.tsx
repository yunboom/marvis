"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { chatKeys, chatMessagesOptions, pendingChatTaskOptions } from "@marvis/core/chat/queries";
import { upsertChatMessageToCaches } from "@marvis/core/chat/message-cache";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  knowledgeAnnotationListOptions,
  knowledgeChangeListOptions,
  knowledgeKeys,
  parseKnowledgeBaseDraft,
  stripKnowledgeBaseDraft,
  type KnowledgeBase,
  type KnowledgeSessionKind,
} from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@marvis/ui/components/ui/dialog";
import { ChatInput } from "../../chat/components/chat-input";
import { ChatMessageList, ChatMessageSkeleton } from "../../chat/components/chat-message-list";
import { useT } from "../../i18n";

export interface OpenKnowledgeSession {
  sessionId: string;
  kind: KnowledgeSessionKind;
  agentName: string;
  kb: KnowledgeBase | null;
  startedAt: string;
}

/** Sends a turn into a knowledge session the same way the chat surfaces do. */
export function useSendToSession() {
  const qc = useQueryClient();

  return async (sessionId: string, content: string, attachmentIds?: string[]) => {
    const result = await api.sendChatMessage(sessionId, content, attachmentIds);
    const createdAt = new Date().toISOString();
    upsertChatMessageToCaches(
      qc,
      sessionId,
      { id: result.message_id, chat_session_id: sessionId, role: "user", content, task_id: result.task_id, created_at: createdAt },
      { seedIfMissing: true },
    );
    qc.setQueryData(chatKeys.pendingTask(sessionId), { task_id: result.task_id, status: "queued", created_at: createdAt });
    void qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
    void qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
    void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
  };
}

/**
 * The knowledge session window: the conversation with the maintainer agent on
 * the left, what it produced (change requests, annotations, a draft) on the right.
 */
export function KnowledgeSessionPanel({
  session,
  onClose,
  onOpenChange,
  onOpenAnnotations,
  onCreateFromDraft,
}: {
  session: OpenKnowledgeSession;
  onClose: () => void;
  onOpenChange: (number: number) => void;
  onOpenAnnotations: () => void;
  onCreateFromDraft: (draft: { name: string; description: string; purpose: string }) => Promise<void>;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const send = useSendToSession();
  const { data: messages = [], isLoading } = useQuery(chatMessagesOptions(session.sessionId));
  const { data: pending } = useQuery(pendingChatTaskOptions(session.sessionId));
  const { data: changes = [] } = useQuery(knowledgeChangeListOptions(wsId, "all"));
  const { data: annotations = [] } = useQuery(knowledgeAnnotationListOptions(wsId, session.kb?.id ?? ""));
  const [creating, setCreating] = useState(false);

  const running = !!pending?.task_id;
  const produced = changes.filter((c) => c.chat_session_id === session.sessionId);
  const found = annotations.filter((a) => a.author_type === "agent" && a.created_at >= session.startedAt);
  const draft = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") {
        const d = parseKnowledgeBaseDraft(m.content);
        if (d) return d;
      }
    }
    return null;
  }, [messages]);

  const stop = async () => {
    if (!pending?.task_id) return;
    qc.setQueryData(chatKeys.pendingTask(session.sessionId), {});
    try {
      await api.cancelTaskById(pending.task_id, { sessionId: session.sessionId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.session.stop_failed));
    } finally {
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(session.sessionId) });
      void qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="flex h-[calc(100vh-48px)] w-[calc(100vw-48px)] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-title-sm">{t(($) => $.session.titles[session.kind])}</DialogTitle>
            <div className="text-caption text-muted-foreground">
              {t(($) => $.session.subtitle, { agent: session.agentName, kb: session.kb?.name ?? t(($) => $.session.new_kb) })}
            </div>
          </div>
          {running ? (
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <span aria-hidden="true" className="size-2 animate-breathe rounded-full bg-status-done" />
              {t(($) => $.session.running)}
            </span>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1">
          <section aria-label={t(($) => $.session.conversation)} className="flex min-w-0 flex-1 flex-col border-r border-border">
            {isLoading ? (
              <ChatMessageSkeleton />
            ) : messages.length > 0 || running ? (
              <ChatMessageList messages={messages} pendingTask={pending} availability="online" transformContent={stripKnowledgeBaseDraft} />
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-body text-muted-foreground">
                {t(($) => (session.kind === "create" ? $.session.create_prompt : $.session.empty))}
              </div>
            )}
            <ChatInput
              onSend={(content, attachmentIds, commitInput) => {
                void send(session.sessionId, content, attachmentIds)
                  .then(() => commitInput())
                  .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t(($) => $.session.send_failed)));
              }}
              onStop={() => void stop()}
              isRunning={running}
              agentName={session.agentName}
              draftKeyOverride={`knowledge-session:${session.sessionId}`}
              editorKeyOverride={`knowledge-session:${session.sessionId}`}
            />
          </section>
          <aside aria-label={t(($) => $.session.output)} className="flex w-[400px] shrink-0 flex-col bg-muted/20">
            <div className="border-b border-border px-5 py-3.5 font-semibold">
              {t(($) => (session.kind === "fresh" ? $.session.output_findings : session.kind === "create" ? $.session.output_draft : $.session.output_changes))}
            </div>
            <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-4">
              {session.kind === "create" ? (
                draft ? (
                  <div className="rounded-lg border border-border bg-background p-4">
                    <div className="font-medium">{draft.name}</div>
                    <p className="mt-1 text-body text-muted-foreground">{draft.description}</p>
                    <p className="mt-2 text-caption whitespace-pre-line text-muted-foreground">{draft.purpose}</p>
                    <Button
                      className="mt-3"
                      disabled={creating}
                      aria-busy={creating}
                      onClick={async () => {
                        setCreating(true);
                        try {
                          await onCreateFromDraft(draft);
                        } finally {
                          setCreating(false);
                        }
                      }}
                    >
                      {t(($) => $.session.confirm_create)}
                    </Button>
                  </div>
                ) : (
                  <p className="text-caption text-muted-foreground">{t(($) => $.session.draft_pending)}</p>
                )
              ) : session.kind === "fresh" ? (
                <>
                  <p className="text-body">{t(($) => $.session.findings_n, { n: found.length })}</p>
                  {found.length > 0 ? (
                    <Button variant="outline" onClick={onOpenAnnotations}>
                      {t(($) => $.session.open_annotations)}
                    </Button>
                  ) : null}
                </>
              ) : produced.length === 0 ? (
                <p className="text-caption text-muted-foreground">{t(($) => $.session.no_changes_yet)}</p>
              ) : (
                produced.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-caption text-muted-foreground">
                        {t(($) => $.session.change_meta, { number: c.number, files: c.kb_slugs.length })}
                      </div>
                      <div className="truncate font-medium">{c.title}</div>
                    </div>
                    <Button size="sm" onClick={() => onOpenChange(c.number)}>
                      {t(($) => $.session.review)}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
