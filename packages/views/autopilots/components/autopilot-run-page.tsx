"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Webhook,
  Zap,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@marvis/core/api";
import { isAgentRuntimeBound, useAgentPresenceDetail, type AgentAvailability } from "@marvis/core/agents";
import { useAuthStore } from "@marvis/core/auth";
import { useEnsureAutopilotRunChat } from "@marvis/core/autopilots/mutations";
import { autopilotDetailOptions, autopilotRunOptions } from "@marvis/core/autopilots/queries";
import { isTaskMessageTaskId, useTaskMessages } from "@marvis/core/chat/queries";
import { useWorkspaceId } from "@marvis/core/hooks";
import { createLogger } from "@marvis/core/logger";
import { useWorkspacePaths } from "@marvis/core/paths";
import type { Autopilot, AutopilotRun, AutopilotRunSource } from "@marvis/core/types";
import { useActorName } from "@marvis/core/workspace/hooks";
import { agentListOptions, memberListOptions } from "@marvis/core/workspace/queries";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { Button } from "@marvis/ui/components/ui/button";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { cn } from "@marvis/ui/lib/utils";
import { AgentAccessRevokedBanner } from "../../chat/components/agent-access-revoked-banner";
import { ArchivedAgentBanner } from "../../chat/components/archived-agent-banner";
import { ChatInput } from "../../chat/components/chat-input";
import { ChatMessageList, TaskTimelineReply } from "../../chat/components/chat-message-list";
import { ChatQueue } from "../../chat/components/chat-queue";
import { OfflineBanner } from "../../chat/components/offline-banner";
import { RuntimeRequiredBanner } from "../../chat/components/runtime-required-banner";
import { TaskStatusPill } from "../../chat/components/task-status-pill";
import { canAssignAgent } from "../../issues/components/pickers/assignee-picker";
import { ActorAvatar } from "../../common/actor-avatar";
import { formatInTimeZone } from "../../common/format-in-time-zone";
import { buildTimeline } from "../../common/task-transcript";
import { useT } from "../../i18n";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { RichContentScrollRootProvider } from "../../rich-content/scroll-root";
import { instructionsPreview } from "./instructions-preview";
import { RUN_VISUAL, runStatusOf, type RunStatus } from "./run-status";
import { useAutopilotRunConversation } from "./use-autopilot-run-conversation";
import { WebhookPayloadPreview } from "./webhook-payload-preview";

const SOURCE_ICON: Record<AutopilotRunSource, typeof Clock> = {
  schedule: Clock,
  manual: Play,
  webhook: Webhook,
  api: Zap,
};

const KNOWN_SOURCES = Object.keys(SOURCE_ICON) as AutopilotRunSource[];

const logger = createLogger("autopilots.run-page");

const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;

/** Placeholder for a time the run has not reached yet. */
const NO_VALUE = "—";

type LoadProblem = "not_found" | "forbidden" | "load_failed";

function sourceOf(source: string): AutopilotRunSource | null {
  return (KNOWN_SOURCES as string[]).includes(source) ? (source as AutopilotRunSource) : null;
}

function loadProblemOf(error: unknown): LoadProblem {
  if (error instanceof ApiError && error.status === FORBIDDEN_STATUS) return "forbidden";
  // No error with no data is the same answer as a 404: there is nothing to show.
  if (!error || (error instanceof ApiError && error.status === NOT_FOUND_STATUS)) return "not_found";

  return "load_failed";
}

/** The event name a webhook envelope carries, when it carries one. */
function webhookEventOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const event = (payload as Record<string, unknown>).event;

  return typeof event === "string" && event ? event : null;
}

function elapsedMsOf(run: AutopilotRun): number | null {
  if (!run.completed_at || !run.triggered_at) return null;
  const elapsed = Date.parse(run.completed_at) - Date.parse(run.triggered_at);

  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/**
 * /{ws}/autopilots/{id}/runs/{runId}: one run of a run_only autopilot — what
 * triggered it, the agent's execution as one reply, and the run's details.
 */
export function AutopilotRunPage({ autopilotId, runId }: { autopilotId: string; runId: string }) {
  const { t, i18n } = useT("autopilots");
  const wsId = useWorkspaceId();
  const detailQuery = useQuery(autopilotDetailOptions(wsId, autopilotId));
  const runQuery = useQuery(autopilotRunOptions(wsId, autopilotId, runId));
  const [panelOpen, setPanelOpen] = useState(true);

  const autopilot = detailQuery.data?.autopilot;
  const run = runQuery.data;

  if (detailQuery.isLoading || runQuery.isLoading) {
    return (
      <RunShell autopilotId={autopilotId}>
        <RunPageSkeleton />
      </RunShell>
    );
  }

  if (!autopilot || !run) {
    const problem = loadProblemOf(detailQuery.error ?? runQuery.error);

    return (
      <RunShell autopilotId={autopilotId}>
        <div className="m-auto flex flex-col items-center gap-3 text-body text-muted-foreground">
          <p>{t(($) => $.run_page[problem])}</p>
          {problem === "load_failed" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void detailQuery.refetch();
                void runQuery.refetch();
              }}
            >
              {t(($) => $.page.retry)}
            </Button>
          )}
        </div>
      </RunShell>
    );
  }

  const status = runStatusOf(run.status);
  const triggeredAt = run.triggered_at || run.created_at;

  return (
    <RunShell
      autopilotId={autopilotId}
      title={t(($) => $.run_page.title, {
        title: autopilot.title,
        time: formatInTimeZone(triggeredAt, undefined, i18n.language),
      })}
      status={status}
      panelToggle={
        <IconButton
          type="button"
          size="icon"
          className="text-muted-foreground"
          label={panelOpen ? t(($) => $.run_page.hide_panel) : t(($) => $.run_page.show_panel)}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          {panelOpen ? (
            <PanelRightClose className="size-4" aria-hidden="true" />
          ) : (
            <PanelRightOpen className="size-4" aria-hidden="true" />
          )}
        </IconButton>
      }
    >
      <RunConversation autopilot={autopilot} run={run} status={status} />
      {panelOpen && <RunInfoPanel autopilot={autopilot} run={run} status={status} />}
    </RunShell>
  );
}

/** Chrome of the run page: back to the autopilot, the two-line title, status. */
function RunShell({
  autopilotId,
  title,
  status,
  panelToggle,
  children,
}: {
  autopilotId: string;
  title?: string;
  status?: RunStatus;
  panelToggle?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT("autopilots");
  const wsPaths = useWorkspacePaths();
  const router = useNavigation();

  return (
    <div className="flex h-full flex-col">
      <PageHeader className="h-18 gap-3">
        <IconButton
          type="button"
          size="icon"
          label={t(($) => $.run_page.back)}
          onClick={() => router.push(wsPaths.autopilotDetail(autopilotId))}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          {title ? (
            <h1 className="truncate text-title-sm font-semibold">{title}</h1>
          ) : (
            <Skeleton className="h-4 w-48" />
          )}
          <span className="truncate text-caption text-faint-foreground">
            {t(($) => $.run_page.subtitle)}
          </span>
        </div>
        {status && <RunStatusTag status={status} />}
        {panelToggle}
      </PageHeader>
      <div className="flex min-h-0 flex-1 max-lg:flex-col">{children}</div>
    </div>
  );
}

function RunStatusTag({ status, className }: { status: RunStatus; className?: string }) {
  const { t } = useT("autopilots");
  const visual = RUN_VISUAL[status];
  const StatusIcon = visual.icon;

  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-caption",
        className,
      )}
    >
      <StatusIcon
        aria-hidden="true"
        className={cn("size-3.5", visual.color, visual.spin && "animate-spin")}
      />
      {t(($) => $.run_status[status])}
    </span>
  );
}

function RunPageSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="flex gap-2.5">
        <Skeleton className="size-6 rounded-md" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    </div>
  );
}

interface RunExecutor {
  type: Autopilot["assignee_type"];
  id: string;
}

/** The agent the run executed on, or the autopilot's assignee for older servers. */
function runExecutorOf(autopilot: Autopilot, run: AutopilotRun): RunExecutor {
  if (run.agent_id) return { type: "agent", id: run.agent_id };

  return { type: autopilot.assignee_type, id: autopilot.assignee_id };
}

/**
 * Left column: the executor bar, then one conversation — the trigger card and
 * the execution reply as its first turn, the follow-up chat after it, and the
 * chat composer (designs 3.1, 3.4).
 */
function RunConversation({
  autopilot,
  run,
  status,
}: {
  autopilot: Autopilot;
  run: AutopilotRun;
  status: RunStatus;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const { getActorName } = useActorName();
  const executor = runExecutorOf(autopilot, run);
  const isAgent = executor.type === "agent";
  const presence = useAgentPresenceDetail(wsId, isAgent ? executor.id : undefined);
  const availability = presence === "loading" ? undefined : presence.availability;
  const executorName = getActorName(executor.type, executor.id);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const hasTask = isTaskMessageTaskId(run.task_id);

  const firstTurn = (
    <div className="flex flex-col gap-4 pb-3">
      <TriggerCard autopilot={autopilot} run={run} />
      {hasTask && run.task_id ? (
        <RunReply taskId={run.task_id} executor={executor} run={run} status={status} availability={availability} />
      ) : (
        <p className="text-label text-muted-foreground">{t(($) => $.run_page.not_executed)}</p>
      )}
    </div>
  );

  return (
    <section aria-label={executorName} className="flex min-h-0 min-w-0 flex-1 flex-col @container">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-6">
        <ActorAvatar actorType={executor.type} actorId={executor.id} size="sm" profileLink={false} />
        <span className="truncate font-semibold">{executorName}</span>
        <span className="flex-1" />
        {isAgent && availability && (
          <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                availability === "online" ? "bg-success" : "bg-faint-foreground",
              )}
            />
            {availability === "online"
              ? t(($) => $.run_page.runtime_online)
              : t(($) => $.run_page.runtime_offline)}
          </span>
        )}
      </div>

      {hasTask && isAgent ? (
        <RunFollowUp
          autopilotId={autopilot.id}
          run={run}
          agentId={executor.id}
          status={status}
          availability={availability}
          firstTurn={firstTurn}
        />
      ) : (
        <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-y-auto">
          <RichContentScrollRootProvider scrollRoot={scrollRoot}>
            <div className="mx-auto w-full max-w-3xl px-7 py-6">{firstTurn}</div>
          </RichContentScrollRootProvider>
        </div>
      )}
    </section>
  );
}

/**
 * The run's follow-up chat under its first turn, sent, stopped, queued and
 * retried like the chat page. The chat session is created on the first send.
 * Until follow-ups exist the first turn scrolls on its own; after that it
 * heads the chat list so the whole run reads as one conversation.
 */
function RunFollowUp({
  autopilotId,
  run,
  agentId,
  status,
  availability,
  firstTurn,
}: {
  autopilotId: string;
  run: AutopilotRun;
  agentId: string;
  status: RunStatus;
  availability: AgentAvailability | undefined;
  firstTurn: ReactNode;
}) {
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const ensureChat = useEnsureAutopilotRunChat();
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  const draftKey = `autopilot-run:${run.id}`;
  const runId = run.id;
  const { mutateAsync: ensureChatAsync } = ensureChat;
  const ensureSession = useCallback(
    async () => (await ensureChatAsync({ autopilotId, runId })).chat_session_id,
    [ensureChatAsync, autopilotId, runId],
  );
  // Follow-ups sent while the run executes queue behind it, like a turn
  // queued behind the one in progress on the chat page.
  const runInProgress = status === "running";
  const conversation = useAutopilotRunConversation(run.chat_session_id ?? null, ensureSession, draftKey, runInProgress);
  const runTaskId = run.task_id;
  const stopRun = useCallback(async () => {
    if (!runTaskId) return;
    try {
      await api.cancelTaskById(runTaskId);
    } catch (err) {
      // Like a chat turn, the run may have finished before the stop landed.
      logger.warn("stopRun.error", { runId, taskId: runTaskId, err });
    }
  }, [runId, runTaskId]);

  const agent = agents.find((a) => a.id === agentId);
  const memberRole = members.find((m) => m.user_id === user?.id)?.role;
  const agentArchived = !!agent?.archived_at;
  const accessRevoked = !!agent && !canAssignAgent(agent, user?.id, memberRole);
  const runtimeRequired = !!agent && !isAgentRuntimeBound(agent);
  const queuedTasks = conversation.pendingTask?.queued_tasks ?? [];

  let banner: ReactNode;
  if (accessRevoked) banner = <AgentAccessRevokedBanner agentName={agent?.name} />;
  else if (agentArchived) banner = <ArchivedAgentBanner agentName={agent?.name} />;
  else if (runtimeRequired && agent) banner = <RuntimeRequiredBanner agentId={agent.id} agentName={agent.name} />;
  else banner = <OfflineBanner agentName={agent?.name} availability={availability} />;

  return (
    <>
      {conversation.messages.length > 0 ? (
        <ChatMessageList
          messages={conversation.messages}
          pendingTask={conversation.pendingTask}
          availability={availability}
          firstItemIndex={conversation.firstItemIndex}
          hasOlderMessages={conversation.hasOlderMessages}
          isFetchingOlderMessages={conversation.isFetchingOlderMessages}
          onLoadOlderMessages={conversation.fetchOlderMessages}
          onQuickAction={(action) => conversation.send(action.prompt)}
          quickActionsDisabled={conversation.running || accessRevoked || agentArchived || runtimeRequired}
          header={firstTurn}
        />
      ) : (
        <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-y-auto">
          <RichContentScrollRootProvider scrollRoot={scrollRoot}>
            <div className="mx-auto w-full max-w-3xl px-7 py-6">{firstTurn}</div>
          </RichContentScrollRootProvider>
        </div>
      )}
      {banner}
      <ChatQueue
        tasks={queuedTasks}
        headStatus={conversation.pendingTask?.status}
        onSendNow={conversation.queue.handleSendQueuedTaskNow}
        sendNowDisabled={accessRevoked}
        onEdit={conversation.queue.handleEditQueuedTask}
        onRemove={conversation.queue.handleRemoveQueuedTask}
        onClear={conversation.queue.handleClearQueuedTasks}
      />
      <ChatInput
        onSend={conversation.send}
        onStop={runInProgress ? stopRun : conversation.stop}
        isRunning={runInProgress || conversation.running}
        allowSubmitWhileRunning={runInProgress || conversation.pendingTask?.supports_queue === true}
        restoreDraftRequest={conversation.restoreDraftRequest}
        onRestoreDraftApplied={conversation.handleRestoreDraftApplied}
        uploadEnabled={!accessRevoked}
        disabled={agentArchived || accessRevoked || runtimeRequired}
        agentArchived={agentArchived}
        agentAccessRevoked={accessRevoked}
        agentRuntimeRequired={runtimeRequired}
        agentName={agent?.name}
        draftKeyOverride={draftKey}
        editorKeyOverride={draftKey}
      />
    </>
  );
}

/** What fired the run, when, and the instructions it carried. */
function TriggerCard({ autopilot, run }: { autopilot: Autopilot; run: AutopilotRun }) {
  const { t, i18n } = useT("autopilots");
  const source = sourceOf(run.source);
  const SourceIcon = source ? SOURCE_ICON[source] : Zap;
  const event = run.source === "webhook" ? webhookEventOf(run.trigger_payload) : null;
  const preview = instructionsPreview(autopilot.description);
  const meta = [formatInTimeZone(run.triggered_at || run.created_at, undefined, i18n.language), event]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-label">
      <SourceIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium">
            {source ? t(($) => $.run_page.trigger[source]) : run.source}
          </span>
          <span className="text-faint-foreground"> · {meta}</span>
        </div>
        {preview && <p className="mt-0.5 truncate text-muted-foreground">{preview}</p>}
      </div>
    </div>
  );
}

/**
 * The run task's transcript as one agent reply. Reads the same task-messages
 * cache the realtime stream writes, and backfills on mount and when the run
 * finishes so a reconnect gap or the final tail is never missing.
 */
function RunReply({
  taskId,
  executor,
  run,
  status,
  availability,
}: {
  taskId: string;
  executor: RunExecutor;
  run: AutopilotRun;
  status: RunStatus;
  availability: AgentAvailability | undefined;
}) {
  const { t } = useT("autopilots");
  const live = status === "running";
  const { data, isPending, isError } = useTaskMessages(taskId, live);
  const items = useMemo(() => buildTimeline(data ?? []), [data]);

  let body: ReactNode;
  if (isPending && !data) {
    body = (
      <div className="flex flex-col gap-2 pt-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  } else if (isError && !data) {
    body = <p className="text-label text-muted-foreground">{t(($) => $.run_page.transcript_failed)}</p>;
  } else {
    body = (
      <>
        {live && (
          <TaskStatusPill
            pendingTask={{ task_id: taskId, status: "running", created_at: run.triggered_at || run.created_at }}
            taskMessages={data ?? []}
            availability={availability}
          />
        )}
        <TaskTimelineReply
          items={items}
          isStreaming={live}
          elapsedMs={elapsedMsOf(run)}
          failed={status === "failed"}
        />
      </>
    );
  }

  return (
    <div className="flex gap-2.5">
      <ActorAvatar actorType={executor.type} actorId={executor.id} size="sm" profileLink={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">{body}</div>
    </div>
  );
}

/** Right column: the run's facts, its failure and its webhook payload. */
function RunInfoPanel({
  autopilot,
  run,
  status,
}: {
  autopilot: Autopilot;
  run: AutopilotRun;
  status: RunStatus;
}) {
  const { t, i18n } = useT("autopilots");
  const wsPaths = useWorkspacePaths();
  const { getActorName } = useActorName();
  const executor = runExecutorOf(autopilot, run);
  const source = sourceOf(run.source);
  const showPayload = run.source === "webhook" && run.trigger_payload != null;

  return (
    <aside
      aria-label={t(($) => $.run_page.panel_title)}
      className="flex w-[340px] shrink-0 flex-col gap-5 overflow-y-auto border-l bg-surface-sunken/20 px-6 py-5 max-lg:max-h-[50%] max-lg:w-full max-lg:border-t max-lg:border-l-0"
    >
      <h2 className="text-title-sm font-semibold">{t(($) => $.run_page.panel_title)}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-body">
        <InfoRow label={t(($) => $.run_page.field_status)}>
          {t(($) => $.run_status[status])}
        </InfoRow>
        <InfoRow label={t(($) => $.run_page.field_source)}>
          {source ? t(($) => $.run_source[source]) : run.source}
        </InfoRow>
        <InfoRow label={t(($) => $.run_page.field_triggered_at)}>
          <span className="tabular-nums">
            {formatInTimeZone(run.triggered_at || run.created_at, undefined, i18n.language)}
          </span>
        </InfoRow>
        <InfoRow label={t(($) => $.run_page.field_completed_at)}>
          <span className="tabular-nums">
            {run.completed_at ? formatInTimeZone(run.completed_at, undefined, i18n.language) : NO_VALUE}
          </span>
        </InfoRow>
        <InfoRow label={t(($) => $.run_page.field_assignee)}>
          <span className="flex min-w-0 items-center gap-1.5">
            <ActorAvatar
              actorType={executor.type}
              actorId={executor.id}
              size="xs"
              enableHoverCard={executor.type === "agent"}
            />
            <span className="truncate">{getActorName(executor.type, executor.id)}</span>
          </span>
        </InfoRow>
        <InfoRow label={t(($) => $.run_page.field_autopilot)}>
          <AppLink
            href={wsPaths.autopilotDetail(autopilot.id)}
            className="inline-flex max-w-full items-center gap-0.5 hover:underline"
          >
            <span className="truncate">{autopilot.title}</span>
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
          </AppLink>
        </InfoRow>
        {run.failure_reason && (
          <InfoRow label={t(($) => $.run_page.field_failure)}>
            <span className="break-words text-destructive">{run.failure_reason}</span>
          </InfoRow>
        )}
      </dl>
      {showPayload && (
        <section className="flex flex-col gap-2">
          <h3 className="text-label text-muted-foreground">{t(($) => $.run_page.field_payload)}</h3>
          <WebhookPayloadPreview payload={run.trigger_payload} defaultOpen />
        </section>
      )}
    </aside>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}
