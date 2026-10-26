"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@marvis/core/api";
import { isAgentRuntimeBound, useAgentPresenceDetail } from "@marvis/core/agents";
import { useChatStore } from "@marvis/core/chat";
import { useWorkspaceId } from "@marvis/core/hooks";
import { KB_NEW_JOB_PARAMS, useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbJobOptions, kbKeys } from "@marvis/core/kb/queries";
import { useCreateKbJob, useDiscardKbJob, useSubmitKbJob } from "@marvis/core/kb/mutations";
import { runtimeDisplayLabel } from "@marvis/core/runtimes";
import { runtimeListOptions } from "@marvis/core/runtimes/queries";
import { agentListOptions } from "@marvis/core/workspace/queries";
import type { CreateKbJobRequest, KbJobStarter } from "@marvis/core/types";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { ChatInput } from "../../chat/components/chat-input";
import { ChatQueue } from "../../chat/components/chat-queue";
import { ChatMessageList, ChatMessageSkeleton } from "../../chat/components/chat-message-list";
import { AgentPicker } from "../../autopilots/components/pickers/agent-picker";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbJobDraftPanel } from "./kb-job-draft-panel";
import { parseKbJobRoute } from "./kb-job-state";
import { useKbJobConversation } from "./use-kb-job-conversation";

/** The opener cards of a new job (design 9.2); two of them schedule runs. */
const STARTER_CARDS = [
  { key: "ingest", starter: "ingest" },
  { key: "health", starter: "health" },
  { key: "merge", starter: "merge" },
  { key: "annotations", starter: "annotations" },
  { key: "schedule_ingest", starter: "schedule" },
  { key: "schedule_health", starter: "schedule" },
] as const satisfies readonly { key: string; starter: KbJobStarter }[];

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
  children,
}: {
  kbSlug: string;
  title: string;
  runtimeLabel: string;
  children: ReactNode;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-[72px] shrink-0 items-center gap-3 border-b px-5">
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
      <ActorAvatar actorType="agent" actorId={agent.id} size="sm" />
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
 * URL and writes the request out in the composer.
 */
function KbNewJob({ kbSlug }: { kbSlug: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { searchParams, replace } = useNavigation();
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const createJob = useCreateKbJob();

  const starter = readStarter(searchParams.get(KB_NEW_JOB_PARAMS.starter));
  const annotationIds = splitIds(searchParams.get(KB_NEW_JOB_PARAMS.annotations));
  const pageId = searchParams.get(KB_NEW_JOB_PARAMS.page) ?? "";
  const sources = splitIds(searchParams.get(KB_NEW_JOB_PARAMS.sources));
  const prefill = searchParams.get(KB_NEW_JOB_PARAMS.message) ?? "";
  const draftKey = `kb-job-new:${kbSlug}`;

  const runnable = useMemo(() => agents.filter((a) => !a.archived_at && isAgentRuntimeBound(a)), [agents]);
  const [agentId, setAgentId] = useState("");
  const chosen = agentId || runnable[0]?.id || "";
  const runtimeLabel = useAgentRuntimeLabel(chosen);

  // The entry point's request goes into the composer once; the member picks
  // the agent and sends it.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !prefill) return;
    prefilled.current = true;
    useChatStore.getState().setInputDraft(draftKey, prefill);
  }, [draftKey, prefill]);

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
                {chosen && <ActorAvatar actorType="agent" actorId={chosen} size="lg" />}
                <h2 className="text-title-lg font-semibold">{t(($) => $.job.start_question, { name: kbName })}</h2>
              </div>
              <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
                {STARTER_CARDS.map((card) => {
                  const cardTitle = t(($) => $.job.starters[card.key].title);
                  const description = t(($) => $.job.starters[card.key].description);
                  return (
                    <button
                      key={card.key}
                      type="button"
                      disabled={!chosen || createJob.isPending}
                      onClick={() => void start({ starter: card.starter, name: cardTitle, message: t(($) => $.job.starter_message, { title: cardTitle, description }) })}
                      className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
                    >
                      <span className="text-body font-medium">{cardTitle}</span>
                      <span className="text-caption leading-5 text-faint-foreground">{description}</span>
                    </button>
                  );
                })}
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
                sources: sources.length ? sources : undefined,
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
    <JobShell kbSlug={kbSlug} title={job.name} runtimeLabel={runtimeLabel}>
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
            quickActionsDisabled={running || ended}
          />
        )}
        {ended ? (
          <p className="shrink-0 border-t px-6 py-4 text-center text-label text-muted-foreground">{t(($) => $.job.ended)}</p>
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
