"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowLeft, ChevronDown, MoreHorizontal, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@marvis/core/api";
import { isAgentRuntimeBound, useAgentPresenceDetail } from "@marvis/core/agents";
import { useAuthStore } from "@marvis/core/auth";
import { useChatStore } from "@marvis/core/chat";
import { useWorkspaceId } from "@marvis/core/hooks";
import { KB_NEW_JOB_PARAMS, useWorkspacePaths } from "@marvis/core/paths";
import { kbAnnotationListOptions, kbBaseDetailOptions, kbJobOptions, kbKeys, kbPageOptions } from "@marvis/core/kb/queries";
import {
  useCreateKbJob,
  useDeleteKbJob,
  useDiscardKbJob,
  useSetKbJobArchived,
  useSubmitKbJob,
} from "@marvis/core/kb/mutations";
import { runtimeDisplayLabel } from "@marvis/core/runtimes";
import { runtimeListOptions } from "@marvis/core/runtimes/queries";
import { agentListOptions, memberListOptions } from "@marvis/core/workspace/queries";
import type { CreateKbJobRequest, KbJobStarter } from "@marvis/core/types";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { ChatInput } from "../../chat/components/chat-input";
import { ChatQueue } from "../../chat/components/chat-queue";
import { ChatMessageList, ChatMessageSkeleton } from "../../chat/components/chat-message-list";
import { AgentPicker } from "../../autopilots/components/pickers/agent-picker";
import { canAssignAgent } from "../../issues/components/pickers/assignee-picker";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { pageTitle } from "../components/kb-page-body";
import { KbJobDraftPanel } from "./kb-job-draft-panel";
import { parseKbJobRoute } from "./kb-job-state";
import { useKbJobRequests, useKbJobStarters, type KbJobRequestContext } from "./kb-job-prompts";
import { useKbJobConversation } from "./use-kb-job-conversation";

const KNOWN_STARTERS: readonly KbJobStarter[] = ["ingest", "health", "merge", "annotations", "new_page", "schedule", "custom"];

function readStarter(value: string | null): KbJobStarter | null {
  return value && (KNOWN_STARTERS as readonly string[]).includes(value) ? (value as KbJobStarter) : null;
}

function splitIds(value: string | null): string[] {
  return (value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

/** Chrome of a job: back to the list, the job's name, the agent's runtime. */
function JobShell({
  kbSlug,
  title,
  runtimeLabel,
  actions,
  children,
}: {
  kbSlug: string;
  title: string;
  runtimeLabel: string;
  /** The job's ⋯ menu, once the job exists. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <IconButton
          type="button"
          variant="ghost"
          size="icon"
          label={t(($) => $.job.back)}
          onClick={() => push(p.kbJobs(kbSlug))}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </IconButton>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-body-lg font-semibold">{title}</h1>
          <span className="truncate text-caption text-faint-foreground">
            {t(($) => $.job.subtitle, { name: base?.name ?? kbSlug })}
          </span>
        </div>
        <span className="flex-1" />
        {runtimeLabel && (
          <span className="max-w-64 truncate rounded-full bg-muted px-3 py-1 text-caption max-md:hidden">{runtimeLabel}</span>
        )}
        {actions}
      </header>
      <div className="flex min-h-0 flex-1 max-lg:flex-col">{children}</div>
    </div>
  );
}

/** The executor row above the conversation; a picker while the job is new. */
function AgentRow({ agentId, onPick }: { agentId: string; onPick?: (agentId: string) => void }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const presence = useAgentPresenceDetail(wsId, agentId || undefined);
  const agent = agents.find((a) => a.id === agentId);
  const online = presence !== "loading" && presence.availability === "online";

  const identity = agent ? (
    <>
      <ActorAvatar actorType="agent" actorId={agent.id} size="sm" profileLink={false} />
      <span className="truncate font-semibold">{agent.name}</span>
    </>
  ) : (
    <span className="text-muted-foreground">{t(($) => $.job.pick_agent)}</span>
  );

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-6">
      {onPick && <span className="shrink-0 text-caption text-faint-foreground">{t(($) => $.job.executor)}</span>}
      {onPick ? (
        <AgentPicker
          agentsOnly
          assignee={agentId ? { type: "agent", id: agentId } : null}
          onChange={(next) => onPick(next.id)}
          triggerRender={
            <button type="button" className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-hover" />
          }
          trigger={
            <>
              {identity}
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          }
        />
      ) : (
        <span className="flex min-w-0 items-center gap-2">{identity}</span>
      )}
      <span className="flex-1" />
      {agent && (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-faint-foreground")} />
          {online ? t(($) => $.job.runtime_online) : t(($) => $.job.runtime_offline)}
        </span>
      )}
    </div>
  );
}

function useAgentRuntimeLabel(agentId: string): string {
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const agent = agents.find((a) => a.id === agentId);
  const runtime = runtimes.find((r) => r.id === agent?.runtime_id);

  return runtime ? runtimeDisplayLabel(runtime) : "";
}

/** The right side before the job exists: nothing to show yet. */
function EmptyDraftSide() {
  const { t } = useT("kb");

  return (
    <section
      aria-label={t(($) => $.job.draft.title)}
      className="flex w-[560px] max-w-[48%] shrink-0 flex-col gap-3 border-l bg-surface-sunken/20 px-6 py-5 max-lg:hidden"
    >
      <h2 className="text-title font-semibold">{t(($) => $.job.draft.title)}</h2>
      <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.job.draft.empty)}</p>
    </section>
  );
}

/**
 * A new job (designs 9.2, 9.8, 4.3): pick the executing agent, then start
 * from an opener card or describe the job. An entry point (annotations,
 * "check this page", the tree's "+", raw files) brings its context in the
 * URL; the page writes the request out in the composer, links included, so
 * the member sees exactly what will be sent.
 */
function KbNewJob({ kbSlug }: { kbSlug: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { searchParams, replace } = useNavigation();
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const user = useAuthStore((s) => s.user);
  const createJob = useCreateKbJob();

  const starter = readStarter(searchParams.get(KB_NEW_JOB_PARAMS.starter));
  const annotationsParam = searchParams.get(KB_NEW_JOB_PARAMS.annotations);
  const annotationIds = useMemo(() => splitIds(annotationsParam), [annotationsParam]);
  const pageId = searchParams.get(KB_NEW_JOB_PARAMS.page) ?? "";
  const sourcesParam = searchParams.get(KB_NEW_JOB_PARAMS.sources);
  const sources = useMemo(() => splitIds(sourcesParam), [sourcesParam]);
  const typed = searchParams.get(KB_NEW_JOB_PARAMS.message) ?? "";
  const draftKey = `kb-job-new:${kbSlug}`;

  // The default executor must be one the member may invoke (spec 10); the
  // server rejects the rest with 403.
  const memberRole = members.find((m) => m.user_id === user?.id)?.role;
  const runnable = useMemo(
    () => agents.filter((a) => !a.archived_at && isAgentRuntimeBound(a) && canAssignAgent(a, user?.id, memberRole)),
    [agents, user?.id, memberRole],
  );
  const [agentId, setAgentId] = useState("");
  const chosen = agentId || runnable[0]?.id || "";
  const runtimeLabel = useAgentRuntimeLabel(chosen);

  const promptBase = useMemo(() => ({ id: base?.id ?? "", name: base?.name ?? kbSlug }), [base?.id, base?.name, kbSlug]);
  const starters = useKbJobStarters(promptBase);
  const requests = useKbJobRequests();

  // The brought-in page and annotations are named in the request, so their
  // titles load before the request is written.
  const pageQuery = useQuery(kbPageOptions(wsId, pageId, ""));
  const annotationQuery = useQuery({
    ...kbAnnotationListOptions(wsId, kbSlug, "all"),
    enabled: !!wsId && !!kbSlug && annotationIds.length > 0,
  });
  const contextReady =
    !!base && (!pageId || !pageQuery.isPending) && (annotationIds.length === 0 || !annotationQuery.isPending);
  const request = useMemo(() => {
    if (!contextReady || !starter) return typed;
    const context: KbJobRequestContext = { sources, text: typed };
    if (pageId) context.page = { id: pageId, title: pageQuery.data ? pageTitle(pageQuery.data) : kbSlug };
    if (annotationIds.length) {
      const byId = new Map((annotationQuery.data ?? []).map((a) => [a.id, a]));
      context.annotations = annotationIds.map((id) => ({ id, where: byId.get(id)?.page_title || promptBase.name }));
    }
    return requests.compose(starter, promptBase, context);
  }, [contextReady, starter, typed, pageId, pageQuery.data, annotationQuery.data, annotationIds, sources, promptBase, requests, kbSlug]);

  // The entry point's request goes into the composer once; the member picks
  // the agent and sends it.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !request || (starter && !contextReady)) return;
    prefilled.current = true;
    useChatStore.getState().setInputDraft(draftKey, request);
  }, [draftKey, request, starter, contextReady]);

  const start = async (data: Omit<CreateKbJobRequest, "agent_id">, commitInput?: () => void) => {
    if (!chosen) {
      toast.error(t(($) => $.job.pick_agent_first));
      return false;
    }
    try {
      const job = await createJob.mutateAsync({ kb: kbSlug, data: { ...data, agent_id: chosen } });
      commitInput?.();
      replace(p.kbJob(kbSlug, job.id));
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : t(($) => $.job.start_failed));
      return false;
    }
  };

  const title = starter ? t(($) => $.job.names[starter]) : t(($) => $.job.new_title);
  const kbName = base?.name ?? kbSlug;

  return (
    <JobShell kbSlug={kbSlug} title={title} runtimeLabel={runtimeLabel}>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col @container">
        <AgentRow agentId={chosen} onPick={setAgentId} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
          {!starter && (
            <>
              <div className="flex flex-col items-center gap-2 pt-6">
                {chosen && <ActorAvatar actorType="agent" actorId={chosen} size="lg" profileLink={false} />}
                <h2 className="text-title-lg font-semibold">{t(($) => $.job.start_question, { name: kbName })}</h2>
              </div>
              <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
                {starters.map((card) => (
                  <button
                    key={card.key}
                    type="button"
                    disabled={!chosen || !base || createJob.isPending}
                    onClick={() => void start({ starter: card.starter, name: card.label, message: card.prompt })}
                    className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
                  >
                    <span className="text-body font-medium">{card.label}</span>
                    <span className="text-caption leading-5 text-faint-foreground">{card.description}</span>
                  </button>
                ))}
              </div>
              <p className="text-center text-caption text-faint-foreground">{t(($) => $.job.start_hint)}</p>
            </>
          )}
        </div>
        <ChatInput
          onSend={(content, _attachmentIds, commitInput) =>
            start(
              {
                starter: starter ?? "custom",
                name: starter ? title : undefined,
                message: content,
                annotation_ids: annotationIds.length ? annotationIds : undefined,
                page_id: pageId || undefined,
              },
              commitInput,
            )
          }
          disabled={!chosen || createJob.isPending}
          noAgent={runnable.length === 0}
          agentName={agents.find((a) => a.id === chosen)?.name}
          draftKeyOverride={draftKey}
          editorKeyOverride={draftKey}
        />
      </section>
      <EmptyDraftSide />
    </JobShell>
  );
}

/**
 * The job's ⋯ menu, as the chat header's: archive, or once archived,
 * unarchive and delete. Delete asks first, awaits the server, then leaves
 * for the job list.
 */
function JobActions({ kbSlug, jobId, name, archived }: { kbSlug: string; jobId: string; name: string; archived: boolean }) {
  const { t } = useT("kb");
  const { t: tCommon } = useT("common");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const setArchived = useSetKbJobArchived();
  const deleteJob = useDeleteKbJob();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const archive = (next: boolean) =>
    setArchived.mutate(
      { jobId, archived: next },
      {
        onError: (err) =>
          toast.error(err instanceof ApiError && err.message ? err.message : t(($) => $.job.archive_failed)),
      },
    );
  const doDelete = async () => {
    try {
      await deleteJob.mutateAsync(jobId);
      setConfirmDelete(false);
      push(p.kbJobs(kbSlug));
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : t(($) => $.job.delete_failed));
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              label={tCommon(($) => $.more_actions)}
              tooltipSide="bottom"
              size="icon"
              className="size-9 text-muted-foreground"
            />
          }
        >
          <MoreHorizontal className="size-4.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {archived ? (
            <>
              <DropdownMenuItem onClick={() => archive(false)}>
                <ArchiveRestore className="h-4 w-4" />
                {t(($) => $.job.unarchive)}
              </DropdownMenuItem>
              {/* Hard delete is offered only once a job is archived. */}
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" />
                {t(($) => $.job.delete)}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={() => archive(true)}>
              <Archive className="h-4 w-4" />
              {t(($) => $.job.archive)}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleteJob.isPending && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.job.delete_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.job.delete_dialog.description, { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteJob.isPending}>{t(($) => $.job.delete_dialog.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteJob.isPending}
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteJob.isPending ? t(($) => $.job.delete_dialog.confirming) : t(($) => $.job.delete_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** An existing job: its conversation on the left, its draft on the right. */
function KbJobConversation({ kbSlug, jobId }: { kbSlug: string; jobId: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { data: job, isLoading, isError } = useQuery(kbJobOptions(wsId, jobId));
  const presence = useAgentPresenceDetail(wsId, job?.agent_id);
  const conversation = useKbJobConversation(job?.chat_session_id ?? "");
  const submit = useSubmitKbJob();
  const discard = useDiscardKbJob();
  const runtimeLabel = useAgentRuntimeLabel(job?.agent_id ?? "");

  // A finished turn changes the job's state and last reply, and usually its
  // draft; the draft events cover writes, this covers the end of the turn.
  const running = conversation.running;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: kbKeys.job(wsId, jobId) });
    wasRunning.current = running;
  }, [running, qc, wsId, jobId]);

  if (isLoading) {
    return (
      <JobShell kbSlug={kbSlug} title="" runtimeLabel="">
        <ChatMessageSkeleton />
      </JobShell>
    );
  }
  if (isError || !job) {
    return (
      <JobShell kbSlug={kbSlug} title="" runtimeLabel="">
        <p className="m-auto text-body text-muted-foreground">{t(($) => $.job.not_found)}</p>
      </JobShell>
    );
  }

  const ended = job.draft?.status === "merged" || job.draft?.status === "discarded" || job.merge_request?.status === "merged";
  // An archived job's chat is read-only, as an archived chat is.
  const readOnly = ended || job.archived;
  const queuedTasks = conversation.pendingTask?.queued_tasks ?? [];

  const onSubmit = () => {
    submit.mutate(jobId, {
      onSuccess: (mr) => toast.success(t(($) => $.job.draft.submitted_toast, { number: mr.number })),
      onError: (err) =>
        toast.error(err instanceof ApiError && err.message ? err.message : t(($) => $.job.draft.submit_failed)),
    });
  };
  const onDiscard = async () => {
    try {
      await discard.mutateAsync(jobId);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : t(($) => $.job.draft.discard_failed));
      return false;
    }
  };

  return (
    <JobShell
      kbSlug={kbSlug}
      title={job.name}
      runtimeLabel={runtimeLabel}
      actions={<JobActions kbSlug={kbSlug} jobId={jobId} name={job.name} archived={job.archived} />}
    >
      <section aria-label={job.agent_name} className="flex min-h-0 min-w-0 flex-1 flex-col @container">
        <AgentRow agentId={job.agent_id} />
        {conversation.loading ? (
          <ChatMessageSkeleton />
        ) : (
          <ChatMessageList
            key={job.chat_session_id}
            messages={conversation.messages}
            pendingTask={conversation.pendingTask}
            availability={presence === "loading" ? undefined : presence.availability}
            firstItemIndex={conversation.firstItemIndex}
            hasOlderMessages={conversation.hasOlderMessages}
            isFetchingOlderMessages={conversation.isFetchingOlderMessages}
            onLoadOlderMessages={conversation.fetchOlderMessages}
            onQuickAction={(action) => conversation.send(action.prompt)}
            quickActionsDisabled={running || readOnly}
          />
        )}
        {readOnly ? (
          <p className="shrink-0 border-t px-6 py-4 text-center text-label text-muted-foreground">
            {job.archived ? t(($) => $.job.archived_notice) : t(($) => $.job.ended)}
          </p>
        ) : (
          <>
            <ChatQueue
              tasks={queuedTasks}
              headStatus={conversation.pendingTask?.status}
              onSendNow={conversation.queue.handleSendQueuedTaskNow}
              onEdit={conversation.queue.handleEditQueuedTask}
              onRemove={conversation.queue.handleRemoveQueuedTask}
              onClear={conversation.queue.handleClearQueuedTasks}
            />
            <ChatInput
              onSend={conversation.send}
              onStop={conversation.stop}
              isRunning={running}
              allowSubmitWhileRunning={conversation.pendingTask?.supports_queue === true}
              restoreDraftRequest={conversation.restoreDraftRequest}
              onRestoreDraftApplied={conversation.handleRestoreDraftApplied}
              agentName={job.agent_name}
              draftKeyOverride={job.chat_session_id}
              editorKeyOverride={`kb-job:${job.chat_session_id}`}
            />
          </>
        )}
      </section>
      <KbJobDraftPanel
        kbSlug={kbSlug}
        job={job}
        running={running}
        onSendMessage={(content) => void conversation.send(content)}
        onSubmit={onSubmit}
        onDiscard={onDiscard}
        submitting={submit.isPending}
        discarding={discard.isPending}
      />
    </JobShell>
  );
}

/** /kb/{slug}/jobs/new and /kb/{slug}/jobs/{id}. */
export function KbJobPage() {
  const { pathname } = useNavigation();
  const route = parseKbJobRoute(pathname);

  if (route.view === "new") return <KbNewJob key={route.kbSlug} kbSlug={route.kbSlug} />;

  return <KbJobConversation key={route.jobId} kbSlug={route.kbSlug} jobId={route.jobId} />;
}
