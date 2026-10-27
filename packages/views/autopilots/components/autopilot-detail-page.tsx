"use client";

import { useState, type ReactNode } from "react";
import {
  Zap, Play, Clock, Plus, Trash2, CheckCircle2, XCircle, Loader2, Pencil,
  Ban, ChevronDown, ChevronLeft, ChevronRight,
  Webhook, RotateCw, Server,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { autopilotDetailOptions, autopilotRunsOptions, autopilotRunOptions } from "@marvis/core/autopilots/queries";
import { projectDetailOptions } from "@marvis/core/projects/queries";
import {
  useUpdateAutopilot,
  useDeleteAutopilot,
  useTriggerAutopilot,
  useCreateAutopilotTrigger,
  useDeleteAutopilotTrigger,
  useRotateAutopilotTriggerWebhookToken,
} from "@marvis/core/autopilots/mutations";
import { buildAutopilotWebhookUrl } from "@marvis/core/autopilots";
import { api, clientErrorMessage, dispatchReasonCode } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import { useNavigation, AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { Button } from "@marvis/ui/components/ui/button";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { Switch } from "@marvis/ui/components/ui/switch";
import { cn } from "@marvis/ui/lib/utils";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
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
import { ScheduleEditor } from "./schedule-editor/schedule-editor";
import { WebhookUrlField } from "./webhook-url-field";
import { getDefaultScheduleConfig, type ScheduleConfig } from "./schedule-editor/model";
import { browserTimezone } from "../../common/timezone-select";
import { cronFields, parseCron, toCron } from "./schedule-editor/cron-mapping";
import { useDescribeSchedule } from "./schedule-editor/describe";
import { formatInTimeZone } from "../../common/format-in-time-zone";
import { SegmentedToggle } from "../../common/segmented-toggle";
import { useScheduleSubmitGate } from "./schedule-editor/validate";
import type {
  AutopilotExecutionMode,
  AutopilotRun,
  AutopilotSubscriber,
  AutopilotTrigger,
} from "@marvis/core/types";
import type { AgentTask } from "@marvis/core/types/agent";
import { TranscriptButton } from "../../common/task-transcript";
import { CollapsibleInstructions } from "./collapsible-instructions";
import { earliestScheduledRun } from "./next-run";
import { AutopilotDialog } from "./autopilot-dialog";
import { EditScheduleTriggerDialog } from "./edit-schedule-trigger-dialog";
import { runNowToastKind, runNowBlockedKey } from "./run-now-toast";
import { WebhookPayloadPreview } from "./webhook-payload-preview";
import { WebhookDeliveriesSection } from "./webhook-deliveries-section";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";
import { PageHeader } from "../../layout/page-header";

// A run that already happened is an instant in the reader's day, so it reads in
// the reader's zone (no timeZone passed). A run that is still to come belongs to
// the schedule that will fire it — see the trigger row, which passes the
// trigger's own timezone.
type RunStatus = "issue_created" | "running" | "skipped" | "completed" | "failed";

const RUN_VISUAL: Record<RunStatus, { color: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  issue_created: { color: "text-blue-500", icon: Clock },
  running: { color: "text-blue-500", icon: Loader2, spin: true },
  // `skipped` (admission check found the assignee runtime offline,
  // MUL-1899) is muted so it doesn't read as a failure-ratio inflator.
  // The row still shows failure_reason which carries the skip context.
  skipped: { color: "text-muted-foreground", icon: Ban },
  completed: { color: "text-emerald-500", icon: CheckCircle2 },
  failed: { color: "text-destructive", icon: XCircle },
};

// WebhookPayloadSlot lazy-fetches the full run (incl. trigger_payload) once
// the parent dialog actually mounts this slot. The list endpoint omits
// trigger_payload to keep responses small (worst case 256 KiB × N runs),
// so the detail-on-demand fetch lives here.
function WebhookPayloadSlot({ autopilotId, runId }: { autopilotId: string; runId: string }) {
  const wsId = useWorkspaceId();
  const { data, isLoading } = useQuery(
    autopilotRunOptions(wsId, autopilotId, runId),
  );
  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }
  if (!data || data.trigger_payload == null) {
    return null;
  }
  return <WebhookPayloadPreview payload={data.trigger_payload} />;
}

const RUN_ROW = "flex h-11 items-center gap-2.5 rounded-xl bg-surface-sunken px-3.5 text-body";

function RunRow({
  run,
  agentId,
  agentName,
  nested = false,
}: {
  run: AutopilotRun;
  agentId: string;
  agentName: string;
  /** A run listed under the skipped group, indented past the group's chevron. */
  nested?: boolean;
}) {
  const { t, i18n } = useT("autopilots");
  const wsPaths = useWorkspacePaths();
  const status = (RUN_VISUAL[run.status as RunStatus] ? (run.status as RunStatus) : "issue_created");
  const visual = RUN_VISUAL[status];
  const StatusIcon = visual.icon;

  // For runs with a task_id (run_only mode), build a minimal AgentTask so
  // TranscriptButton can lazy-load the execution transcript.
  const syntheticTask: AgentTask | null = run.task_id
    ? {
        id: run.task_id,
        agent_id: agentId,
        runtime_id: "",
        issue_id: "",
        status:
          run.status === "running" ? "running" :
          run.status === "completed" ? "completed" :
          run.status === "failed" ? "failed" :
          "queued",
        priority: 0,
        dispatched_at: null,
        started_at: run.triggered_at || null,
        completed_at: run.completed_at || null,
        result: null,
        error: run.failure_reason || null,
        created_at: run.created_at,
      }
    : null;

  const statusLabel = t(($) => $.run_status[status]);
  // The summary says what the run produced; with nothing to say, it falls back
  // to the status itself so the icon never stands alone.
  const summaryIsStatus = !run.issue_id && !run.failure_reason;

  const content = (
    <>
      <StatusIcon
        aria-hidden="true"
        className={cn("size-4 shrink-0", visual.color, visual.spin && "animate-spin")}
      />
      {!summaryIsStatus && <span className="sr-only">{statusLabel}</span>}
      <span className="w-32 shrink-0 tabular-nums">
        {formatInTimeZone(run.triggered_at || run.created_at, undefined, i18n.language)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-label",
          run.failure_reason && !run.issue_id ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {run.issue_id ? t(($) => $.run.issue_linked) : run.failure_reason || statusLabel}
      </span>
      <span className="shrink-0 text-caption text-faint-foreground">
        {t(($) => $.run_source[run.source as "schedule" | "manual" | "webhook" | "api"]) ?? run.source}
      </span>
      {run.issue_id && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />}
      {syntheticTask && !run.issue_id && (
        <TranscriptButton
          task={syntheticTask}
          agentName={agentName}
          isLive={run.status === "running"}
          title={t(($) => $.run.view_log)}
          headerSlot={
            run.source === "webhook" ? (
              <WebhookPayloadSlot autopilotId={run.autopilot_id} runId={run.id} />
            ) : undefined
          }
        />
      )}
    </>
  );

  const rowClass = cn(RUN_ROW, nested && "pl-9.5");

  if (run.issue_id) {
    return (
      <AppLink
        href={wsPaths.issueDetail(run.issue_id)}
        className={cn(rowClass, "cursor-pointer transition-colors hover:bg-surface-hover")}
      >
        {content}
      </AppLink>
    );
  }

  return <div className={rowClass}>{content}</div>;
}

function RunHistoryList({
  runs,
  agentId,
  agentName,
}: {
  runs: AutopilotRun[];
  agentId: string;
  agentName: string;
}) {
  const visibleRuns = runs.filter((run) => run.status !== "skipped");
  const skippedRuns = runs.filter((run) => run.status === "skipped");

  return (
    <div className="flex flex-col gap-1">
      {visibleRuns.map((run) => (
        <RunRow key={run.id} run={run} agentId={agentId} agentName={agentName} />
      ))}
      {skippedRuns.length > 0 && (
        <SkippedRunsGroup runs={skippedRuns} agentId={agentId} agentName={agentName} />
      )}
    </div>
  );
}

function SkippedRunsGroup({
  runs,
  agentId,
  agentName,
}: {
  runs: AutopilotRun[];
  agentId: string;
  agentName: string;
}) {
  const { t, i18n } = useT("autopilots");
  const [open, setOpen] = useState(false);
  const latestRun = runs[0];
  const ToggleIcon = open ? ChevronDown : ChevronRight;

  return (
    <>
      <button
        type="button"
        className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-dashed px-3.5 text-left text-body transition-colors hover:bg-surface-hover"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ToggleIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
        <Ban aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="w-28 shrink-0">{t(($) => $.run.skipped_group.label)}</span>
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {t(($) => $.run.skipped_group.summary, { count: runs.length })}
        </span>
        {latestRun && (
          <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
            {formatInTimeZone(latestRun.triggered_at || latestRun.created_at, undefined, i18n.language)}
          </span>
        )}
      </button>
      {open &&
        runs.map((run) => (
          <RunRow key={run.id} run={run} agentId={agentId} agentName={agentName} nested />
        ))}
    </>
  );
}

export function TriggerRow({ trigger, autopilotId, canWrite }: { trigger: AutopilotTrigger; autopilotId: string; canWrite: boolean }) {
  const { t, i18n } = useT("autopilots");
  const describeSchedule = useDescribeSchedule();
  const deleteTrigger = useDeleteAutopilotTrigger();
  const rotateToken = useRotateAutopilotTriggerWebhookToken();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteTrigger.mutateAsync({ autopilotId, triggerId: trigger.id });
      toast.success(t(($) => $.trigger_row.toast_deleted));
      setConfirmOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.trigger_row.toast_delete_failed),
      );
    } finally {
      setDeleting(false);
    }
  };

  const isWebhook = trigger.kind === "webhook";
  const isApi = trigger.kind === "api";
  // Resolve the URL from the server's webhook_url first, then compose
  // from the API base URL (desktop) or window.origin (web). Falls back
  // to the relative path if neither is available.
  const webhookUrl = isWebhook
    ? buildAutopilotWebhookUrl({
        trigger,
        apiBaseUrl: api.getBaseUrl(),
        currentOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
      })
    : null;

  const handleRotate = async () => {
    try {
      await rotateToken.mutateAsync({ autopilotId, triggerId: trigger.id });
      toast.success(t(($) => $.trigger_row.toast_rotated));
      setRotateOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.trigger_row.toast_rotate_failed),
      );
    }
  };

  const Icon = isWebhook ? Webhook : isApi ? Zap : Clock;
  const showWebhookUrlRow = isWebhook && webhookUrl;
  // null when the expression is beyond the structured model — those rows keep
  // showing the raw cron on its own.
  const scheduleConfig = trigger.cron_expression
    ? parseCron(trigger.cron_expression, trigger.timezone ?? "UTC")
    : null;
  const scheduleDescription = scheduleConfig ? describeSchedule(scheduleConfig) : null;

  // Delete control extracted so a webhook trigger can render it inline
  // with Copy / Rotate on the URL action row (where the other action
  // buttons live), while schedule / api triggers — which have no URL row
  // — keep it pinned to the row's top-right corner. Without this the
  // trash icon visually floats above the URL action buttons because the
  // outer flex uses `items-start`.
  const deleteButton = canWrite ? (
    <IconButton
      size="icon"
      variant="ghost"
      className="h-7 w-7 shrink-0"
      onClick={() => setConfirmOpen(true)}
      label={t(($) => $.trigger_row.delete_dialog.confirm)}
    >
      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
    </IconButton>
  ) : null;

  // Schedule rows only: cron and timezone are the fields this dialog edits, and
  // the API rejects them on any other kind. It rides alongside Delete so the
  // row that states a schedule is also the row that can change it — without it
  // an autopilot with two schedules has no editable schedule at all (MUL-7478).
  const editButton =
    canWrite && trigger.kind === "schedule" ? (
      <IconButton
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => setEditOpen(true)}
        label={t(($) => $.trigger_row.edit_schedule)}
      >
        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
      </IconButton>
    ) : null;

  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-surface-sunken px-3.5 py-3">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-body font-medium">{t(($) => $.trigger_kind[trigger.kind])}</span>
          {trigger.label && (
            <span className="text-caption text-muted-foreground">({trigger.label})</span>
          )}
          {!trigger.enabled && (
            <span className="text-caption bg-muted px-1.5 py-0.5 rounded-xs">
              {t(($) => $.trigger_row.disabled_badge)}
            </span>
          )}
          {isApi && (
            <span className="text-caption bg-muted px-1.5 py-0.5 rounded-xs">
              {t(($) => $.trigger_row.deprecated_badge)}
            </span>
          )}
        </div>
        {trigger.cron_expression && (
          // The plain-language line leads; the raw expression drops to a
          // secondary line so the two never run together as one blob.
          <div className="mt-0.5 space-y-0.5">
            <div className="text-caption text-muted-foreground">
              {scheduleDescription ?? trigger.cron_expression}
              {trigger.timezone && ` (${trigger.timezone})`}
            </div>
            {scheduleDescription !== null && scheduleConfig !== null && (
              // Fields only: the zone already reads out in the sentence above,
              // where a person can use it — same rule as the editor's readback.
              <div className="font-mono text-micro text-muted-foreground">
                {cronFields(scheduleConfig)}
              </div>
            )}
          </div>
        )}
        {/* A disabled trigger keeps the next_run_at it had — the dispatcher
            filters on `enabled` instead of clearing it — so the row would
            otherwise carry the Disabled badge and a promise to run at 09:00
            in the same breath. The badge is the true one. */}
        {trigger.next_run_at && trigger.enabled && (
          <div className="text-caption text-muted-foreground">
            {t(($) => $.trigger_row.next_label, {
              date: formatInTimeZone(
                trigger.next_run_at,
                trigger.timezone ?? undefined,
                i18n.language,
              ),
            })}
          </div>
        )}
        {showWebhookUrlRow && (
          <div className="mt-1.5">
            <WebhookUrlField
              url={webhookUrl}
              actions={
                <>
                  {canWrite && (
                    <IconButton
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => setRotateOpen(true)}
                      label={t(($) => $.trigger_row.rotate_url)}
                      disabled={rotateToken.isPending}
                    >
                      <RotateCw className={cn("h-3.5 w-3.5 text-muted-foreground", rotateToken.isPending && "animate-spin")} />
                    </IconButton>
                  )}
                  {deleteButton}
                </>
              }
            />
          </div>
        )}
      </div>
      {!showWebhookUrlRow && (
        <div className="flex shrink-0 items-center gap-0.5">
          {editButton}
          {deleteButton}
        </div>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={(v) => { if (!v && !deleting) setConfirmOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.trigger_row.delete_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.trigger_row.delete_dialog.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t(($) => $.trigger_row.delete_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting
                ? t(($) => $.trigger_row.delete_dialog.deleting)
                : t(($) => $.trigger_row.delete_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <EditScheduleTriggerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        autopilotId={autopilotId}
        trigger={trigger}
      />
      <AlertDialog open={rotateOpen} onOpenChange={(v) => { if (!v && !rotateToken.isPending) setRotateOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.trigger_row.rotate_confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.trigger_row.rotate_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotateToken.isPending}>
              {t(($) => $.trigger_row.rotate_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRotate} disabled={rotateToken.isPending}>
              {rotateToken.isPending
                ? t(($) => $.trigger_row.rotate_in_progress)
                : t(($) => $.trigger_row.rotate_confirm_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddTriggerDialog({
  open,
  onOpenChange,
  autopilotId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autopilotId: string;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const createTrigger = useCreateAutopilotTrigger();
  const [kind, setKind] = useState<"schedule" | "webhook">("schedule");
  const [config, setConfig] = useState<ScheduleConfig>(() =>
    getDefaultScheduleConfig(browserTimezone()),
  );
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const scheduleGate = useScheduleSubmitGate(wsId);
  const canSubmit = !submitting && (kind !== "schedule" || scheduleGate.scheduleValid);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (kind === "schedule") {
        if (!(await scheduleGate.ensureAccepted(config))) {
          setSubmitting(false);
          return;
        }
        const cronExpr = toCron(config);
        if (!cronExpr.trim()) {
          setSubmitting(false);
          return;
        }
        await createTrigger.mutateAsync({
          autopilotId,
          kind: "schedule",
          cron_expression: cronExpr,
          timezone: config.timezone || undefined,
          label: label.trim() || undefined,
        });
        toast.success(t(($) => $.add_trigger_dialog.toast_added_schedule));
      } else {
        await createTrigger.mutateAsync({
          autopilotId,
          kind: "webhook",
          label: label.trim() || undefined,
        });
        toast.success(t(($) => $.add_trigger_dialog.toast_added_webhook));
      }
      onOpenChange(false);
      setKind("schedule");
      setConfig(getDefaultScheduleConfig(browserTimezone()));
      setLabel("");
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.add_trigger_dialog.toast_add_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{t(($) => $.add_trigger_dialog.title)}</DialogTitle>
        {/* DialogContent is a grid, so without min-w-0 this item's min-width is
            its content's — and the cron readback is one unbreakable line that
            would push the track past the dialog instead of truncating. */}
        <div className="min-w-0 space-y-4 pt-2">
          <div>
            <label className="text-caption font-medium text-muted-foreground">
              {t(($) => $.add_trigger_dialog.type_label)}
            </label>
            <div className="mt-1">
              <SegmentedToggle
                value={kind}
                onChange={setKind}
                buttonClassName="px-3 py-1.5 text-body"
                options={[
                  [
                    "schedule",
                    <span key="schedule" className="flex items-center justify-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      {t(($) => $.add_trigger_dialog.type_schedule)}
                    </span>,
                  ],
                  [
                    "webhook",
                    <span key="webhook" className="flex items-center justify-center gap-1.5">
                      <Webhook className="h-3.5 w-3.5" />
                      {t(($) => $.add_trigger_dialog.type_webhook)}
                    </span>,
                  ],
                ]}
              />
            </div>
          </div>

          {kind === "schedule" ? (
            <ScheduleEditor
              value={config}
              onChange={(next) => {
                scheduleGate.clearRejection();
                setConfig(next);
              }}
              wsId={wsId}
              onValidityChange={scheduleGate.onValidityChange}
              // Same reason as the autopilot dialog: the submit path reads the
              // schedule, validates it over the network, then writes what it
              // read — an edit landing inside that window would be discarded.
              disabled={submitting}
            />
          ) : (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-caption text-muted-foreground">
              {t(($) => $.add_trigger_dialog.webhook_help)}
            </p>
          )}

          <div>
            <label className="text-caption font-medium text-muted-foreground">
              {t(($) => $.add_trigger_dialog.label_field)}
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t(($) => $.add_trigger_dialog.label_placeholder)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-body outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              {submitting
                ? t(($) => $.add_trigger_dialog.submitting)
                : t(($) => $.add_trigger_dialog.submit)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Read-only chip row; edits flow through AutopilotDialog → SubscriberMultiSelect
// so the detail page never holds in-flight selection state.
function SubscriberChips({
  subscribers,
}: {
  subscribers: AutopilotSubscriber[] | undefined;
}) {
  const { t } = useT("autopilots");
  const { getActorName } = useActorName();
  const members = (subscribers ?? []).filter((s) => s.user_type === "member");
  if (members.length === 0) {
    return (
      <div className="mt-1 text-body text-muted-foreground">
        {t(($) => $.detail.field_subscribers_none)}
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {members.map((s) => (
        <span
          key={`${s.user_type}:${s.user_id}`}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-caption"
        >
          <ActorAvatar actorType="member" actorId={s.user_id} size="xs" />
          <span className="max-w-[14rem] truncate">
            {getActorName("member", s.user_id)}
          </span>
        </span>
      ))}
    </div>
  );
}

const SECTION_TITLE = "text-label text-muted-foreground";

function DetailSection({
  title,
  action,
  className,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className={SECTION_TITLE}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function DetailField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={SECTION_TITLE}>{label}</span>
      <div className="min-w-0 text-body">{children}</div>
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
};

function DetailSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader className="h-16">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-16" />
        </div>
      </PageHeader>
      <div className="@container flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-6 px-6 py-6 @4xl:grid-cols-2 @4xl:gap-14 @4xl:px-10 @4xl:py-7">
          <div className="flex flex-col gap-6">
            <Skeleton className="h-12 w-56" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-5 w-32" />
                </div>
              ))}
            </div>
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
          <div className="flex flex-col gap-6">
            <Skeleton className="h-28 w-full" />
            <div className="flex flex-col gap-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AutopilotDetailPage({ autopilotId }: { autopilotId: string }) {
  const { t, i18n } = useT("autopilots");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const router = useNavigation();
  const { getActorName } = useActorName();

  const { data, isLoading } = useQuery(autopilotDetailOptions(wsId, autopilotId));
  const { data: runs = [], isLoading: runsLoading } = useQuery(autopilotRunsOptions(wsId, autopilotId));
  const updateAutopilot = useUpdateAutopilot();
  const deleteAutopilot = useDeleteAutopilot();
  const triggerAutopilot = useTriggerAutopilot();
  const projectId = data?.autopilot.project_id ?? null;
  const { data: project, isLoading: projectLoading } = useQuery({
    ...projectDetailOptions(wsId, projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isLoading) {
    return <DetailSkeleton />;
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t(($) => $.detail.not_found)}
      </div>
    );
  }

  const { autopilot, triggers } = data;
  const collaborators = data.collaborators ?? [];
  // Treat an absent can_write (older server) as "allowed" — the backend is the
  // real gate, so the UI only hides controls when the server explicitly says
  // the caller cannot write.
  const canWrite = autopilot.can_write !== false;
  // Managing the access list is narrower than write: granted collaborators can
  // edit/run but cannot grant/revoke. Fall back to canWrite when the server
  // doesn't send the field (older backend).
  const canManageAccess = autopilot.can_manage_access ?? canWrite;
  const isActive = autopilot.status === "active";
  // A paused autopilot keeps its triggers' next_run_at, but nothing will fire.
  const nextRun = isActive ? earliestScheduledRun(triggers) : null;

  const handleRunNow = async () => {
    try {
      const run = await triggerAutopilot.mutateAsync(autopilotId);
      // Manual "run now" returns 200 even when admission blocks the run, so the
      // toast is driven by the run's domain status, not the HTTP 2xx (MUL-4525).
      // Success is a whitelist (issue_created/running) — a skipped run warns, a
      // failed or unknown/future status errors — never a false "triggered".
      const kind = runNowToastKind(run?.status);
      if (kind === "success") {
        toast.success(t(($) => $.detail.toast_triggered));
        return;
      }
      // reason_code is the stable, typed cause the server decided at admission
      // time; an unknown/absent code degrades to a generic "not triggered".
      const message = t(($) => $.detail[runNowBlockedKey(run?.reason_code)]);
      if (kind === "warning") {
        toast.warning(message);
      } else {
        toast.error(message);
      }
    } catch (e: any) {
      const reason = dispatchReasonCode(e);
      if (reason) {
        toast.error(t(($) => $.detail[runNowBlockedKey(reason)]));
        return;
      }
      // Only a 4xx message is written for the user; a 5xx one is internal
      // server detail (MUL-6472), so an unclassified dispatch failure shows the
      // localized generic sentence instead of the raw body.
      toast.error(clientErrorMessage(e) || t(($) => $.detail.toast_trigger_failed));
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteAutopilot.mutateAsync(autopilotId);
      toast.success(t(($) => $.detail.toast_deleted));
      router.push(wsPaths.autopilots());
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.detail.toast_delete_failed),
      );
      setDeleting(false);
    }
  };

  const handleToggleStatus = (checked: boolean) => {
    updateAutopilot.mutate({ id: autopilotId, status: checked ? "active" : "paused" });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader className="h-16 gap-3">
        <IconButton
          type="button"
          size="icon"
          label={t(($) => $.detail.back)}
          onClick={() => router.push(wsPaths.autopilots())}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title-sm font-semibold">{autopilot.title}</h1>
          <span className="truncate text-caption text-faint-foreground">{t(($) => $.page.title)}</span>
        </div>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              type="button"
              size="icon"
              className="text-muted-foreground"
              label={t(($) => $.detail.edit)}
              onClick={() => setEditDialogOpen(true)}
            >
              <Pencil className="size-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              type="button"
              size="icon"
              className="text-muted-foreground"
              label={t(($) => $.detail.delete_button)}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </IconButton>
            <Button
              type="button"
              className="ml-1"
              onClick={handleRunNow}
              disabled={!isActive || triggerAutopilot.isPending}
              aria-busy={triggerAutopilot.isPending || undefined}
            >
              {triggerAutopilot.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="size-3.5" aria-hidden="true" />
              )}
              {triggerAutopilot.isPending
                ? t(($) => $.detail.running)
                : t(($) => $.detail.run_now)}
            </Button>
          </div>
        )}
      </PageHeader>

      {autopilot.pause_reason === "agent_runtime_required" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-caption text-amber-900 dark:text-amber-100">
          <Server className="size-3.5 shrink-0" />
          <span className="flex-1">
            {t(($) => $.detail.paused_runtime_required)}
          </span>
          {autopilot.assignee_type === "agent" && (
            <AppLink
              href={`${wsPaths.agentDetail(autopilot.assignee_id)}?view=general`}
              className="font-medium underline underline-offset-2"
            >
              {t(($) => $.detail.bind_runtime)}
            </AppLink>
          )}
        </div>
      )}

      <div className="@container flex-1 overflow-y-auto">
        {/* Two columns from @4xl up. Below it each column wrapper turns into
            `display: contents`, so the sections become siblings of one flex
            column and `order-*` sets the stacked sequence: status, prompt,
            runs, then the rest of the configuration. */}
        <div className="flex flex-col gap-6 px-6 py-6 @4xl:grid @4xl:grid-cols-2 @4xl:items-start @4xl:gap-14 @4xl:px-10 @4xl:py-7">
          <div className="contents @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-6">
            <DetailSection title={t(($) => $.detail.section_status)} className="order-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <Switch
                  checked={isActive}
                  onCheckedChange={handleToggleStatus}
                  disabled={autopilot.status === "archived"}
                  aria-label={
                    isActive
                      ? t(($) => $.detail.pause_aria)
                      : t(($) => $.detail.activate_aria)
                  }
                />
                <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2.5 text-caption">
                  <span
                    aria-hidden="true"
                    className={cn("size-1.5 rounded-full", STATUS_DOT[autopilot.status] ?? "bg-muted-foreground")}
                  />
                  {t(($) => $.status[autopilot.status])}
                </span>
                {nextRun && (
                  <span className="text-label text-muted-foreground tabular-nums">
                    {t(($) => $.detail.next_run, {
                      date: formatInTimeZone(nextRun.at, nextRun.timeZone, i18n.language),
                    })}
                  </span>
                )}
              </div>
            </DetailSection>

            <div className="order-4 flex min-w-0 flex-col gap-6">
              <div className="grid grid-cols-2 gap-x-4 gap-y-5">
                <DetailField label={t(($) => $.detail.field_agent)}>
                  <div className="flex items-center gap-2">
                    <ActorAvatar
                      actorType={autopilot.assignee_type}
                      actorId={autopilot.assignee_id}
                      size="sm"
                      enableHoverCard={autopilot.assignee_type === "agent"}
                      showStatusDot={autopilot.assignee_type === "agent"}
                    />
                    <span className="min-w-0 cursor-pointer truncate">
                      {getActorName(autopilot.assignee_type, autopilot.assignee_id)}
                    </span>
                  </div>
                </DetailField>
                <DetailField label={t(($) => $.detail.field_created_by)}>
                  <div className="flex items-center gap-2">
                    {/* Creator may be a member or an agent: the HTTP create path stamps
                        member today, but backend logic also writes created_by_type=agent.
                        ActorAvatar/getActorName resolve both, so never assume member. */}
                    <ActorAvatar
                      actorType={autopilot.created_by_type}
                      actorId={autopilot.created_by_id}
                      size="sm"
                      enableHoverCard
                      showStatusDot={autopilot.created_by_type === "agent"}
                    />
                    <span className="min-w-0 cursor-pointer truncate">
                      {getActorName(autopilot.created_by_type, autopilot.created_by_id)}
                    </span>
                  </div>
                </DetailField>
                <DetailField label={t(($) => $.detail.field_output_mode)}>
                  {t(($) => $.execution_mode[autopilot.execution_mode as AutopilotExecutionMode])}
                </DetailField>
                {/* Shown for BOTH output modes (MUL-6681): a run_only autopilot's
                    project decides its execution environment (repository /
                    local_directory, and therefore worktree isolation), so an
                    operator debugging a run needs to see it here. */}
                <DetailField label={t(($) => $.detail.field_project)}>
                  {!autopilot.project_id ? (
                    <span className="text-muted-foreground">{t(($) => $.detail.no_project)}</span>
                  ) : projectLoading ? (
                    <Skeleton className="h-5 w-32" />
                  ) : project ? (
                    <AppLink
                      href={wsPaths.projectDetail(project.id)}
                      className="inline-flex max-w-full items-center gap-1.5 text-foreground hover:underline"
                    >
                      <ProjectIcon project={project} size="md" />
                      <span className="truncate">{project.title}</span>
                    </AppLink>
                  ) : (
                    <span className="text-muted-foreground">{t(($) => $.detail.project_unavailable)}</span>
                  )}
                </DetailField>
              </div>

              {autopilot.execution_mode === "create_issue" && (
                <DetailSection title={t(($) => $.detail.field_subscribers)}>
                  <SubscriberChips subscribers={autopilot.subscribers} />
                </DetailSection>
              )}

              <DetailSection
                title={t(($) => $.detail.section_triggers)}
                action={
                  canWrite ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="-mr-2 text-muted-foreground"
                      aria-label={t(($) => $.detail.add_trigger)}
                      onClick={() => setTriggerDialogOpen(true)}
                    >
                      <Plus aria-hidden="true" />
                      {t(($) => $.detail.add)}
                    </Button>
                  ) : null
                }
              >
                {triggers.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-4 text-center text-body text-muted-foreground">
                    {t(($) => $.detail.no_triggers)}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {triggers.map((trig) => (
                      <TriggerRow key={trig.id} trigger={trig} autopilotId={autopilotId} canWrite={canWrite} />
                    ))}
                  </div>
                )}
              </DetailSection>

              {/* Webhook deliveries — only renders when at least one webhook
                  trigger is configured. The component does its own fetch so
                  schedule-only autopilots don't pay for an empty list query. */}
              <WebhookDeliveriesSection
                autopilotId={autopilotId}
                hasWebhookTrigger={triggers.some((trig) => trig.kind === "webhook")}
              />
            </div>
          </div>

          <div className="contents @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-6">
            {autopilot.description && (
              <DetailSection title={t(($) => $.detail.field_prompt)} className="order-2">
                <CollapsibleInstructions content={autopilot.description} />
              </DetailSection>
            )}

            <DetailSection title={t(($) => $.detail.section_run_history)} className="order-3">
              {runsLoading ? (
                <div className="flex flex-col gap-1">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full rounded-xl" />
                  ))}
                </div>
              ) : runs.length === 0 ? (
                <div className="rounded-xl border border-dashed p-4 text-center text-body text-muted-foreground">
                  {t(($) => $.detail.no_runs)}
                </div>
              ) : (
                <RunHistoryList
                  runs={runs}
                  agentId={autopilot.assignee_id}
                  agentName={getActorName(autopilot.assignee_type, autopilot.assignee_id)}
                />
              )}
            </DetailSection>
          </div>
        </div>
      </div>

      {/* Mounted only while open, like the edit dialog: otherwise a rejected
          cron leaves scheduleValid=false behind for the next open. */}
      {triggerDialogOpen && (
        <AddTriggerDialog
          open={triggerDialogOpen}
          onOpenChange={setTriggerDialogOpen}
          autopilotId={autopilotId}
        />
      )}
      {editDialogOpen && (
        <AutopilotDialog
          mode="edit"
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          autopilotId={autopilot.id}
          initial={{
            title: autopilot.title,
            description: autopilot.description ?? "",
            project_id: autopilot.project_id ?? null,
            assignee_type: autopilot.assignee_type,
            assignee_id: autopilot.assignee_id,
            execution_mode: autopilot.execution_mode as AutopilotExecutionMode,
            subscriber_user_ids:
              autopilot.subscribers
                ?.filter((s) => s.user_type === "member")
                .map((s) => s.user_id) ?? [],
          }}
          triggers={triggers}
          collaborators={collaborators}
          canManageAccess={canManageAccess}
        />
      )}
      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(v) => { if (!v && !deleting) setDeleteConfirmOpen(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.detail.delete_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.detail.delete_dialog.description, { title: autopilot.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t(($) => $.detail.delete_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting
                ? t(($) => $.detail.delete_dialog.deleting)
                : t(($) => $.detail.delete_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
