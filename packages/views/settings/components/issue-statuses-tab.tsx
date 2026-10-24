"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useAuthStore } from "@marvis/core/auth";
import { derivePRMergeStatus } from "@marvis/core/github";
import { useCurrentWorkspace } from "@marvis/core/paths";
import { issueStatusArchiveConflictCount, createIssueStatusListStore } from "@marvis/core/issue-statuses";
import { baselineFromQuery } from "@marvis/core/issue-views/baseline";
import { IssueSurfaceWithStore } from "../../issues/surface/issue-surface";
import { memberListOptions } from "@marvis/core/workspace/queries";
import {
  issueStatusColor,
  issueStatusGroup,
  compareIssueStatusEntries,
  issueStatusListOptions,
  normalizeIssueStatusCategory,
} from "@marvis/core/issue-statuses/queries";
import {
  useArchiveIssueStatus,
  useCreateIssueStatus,
  useReorderIssueStatuses,
  useUpdateIssueStatus,
} from "@marvis/core/issue-statuses/mutations";
import { STATUS_GROUP_ORDER, statusCategoriesForGroup } from "@marvis/core/issues/config";
import type {
  BuiltInIssueStatus,
  IssueStatusCategory,
  IssueStatusEntry,
  IssueStatusGroup,
  IssueStatusIcon,
} from "@marvis/core/types";
import { ISSUE_STATUS_ICONS } from "@marvis/core/types/issue-status";
import { Button } from "@marvis/ui/components/ui/button";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { Input } from "@marvis/ui/components/ui/input";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { Label as FieldLabel } from "@marvis/ui/components/ui/label";
import { Switch } from "@marvis/ui/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@marvis/ui/components/ui/tooltip";
import { ColorPicker, COLOR_PICKER_PRESETS } from "../../common/color-picker";
import { StatusIcon } from "../../issues/components/status-icon";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import {
  SettingsReadOnlyNotice,
  SettingsTab,
} from "./settings-layout";
import { settingsHref } from "./settings-navigation";

/**
 * Workspace issue status catalog management (MUL-6243).
 *
 * The page is organised by STATUS GROUP, the same four columns the board
 * shows: not started, working, needs attention, ended. A group is display
 * data; each row also shows its lifecycle type, which drives behavior. Working
 * and needs-attention statuses are both started, and ended holds done and
 * closed ones.
 *
 * Every active status can be ordered within its group, and within one
 * lifecycle type in the ended group. Built-in definitions remain locked;
 * moving their display position does not change automation.
 *
 * The chrome is deliberately thin (MUL-6422): one bordered workflow list,
 * muted group headers, and row-level actions revealed only where available.
 */

interface StatusDraft {
  name: string;
  description: string;
  category: IssueStatusCategory;
  group: IssueStatusGroup;
  color: string;
  icon: IssueStatusIcon | "";
}

/** Built-ins whose note says what moving an issue there does; the rest only restate the name. */
const BEHAVIOR_STATUSES = new Set<string>(["backlog", "todo", "in_review"]);

const EMPTY_DRAFT: StatusDraft = {
  name: "",
  description: "",
  category: "unstarted",
  group: "not_started",
  color: COLOR_PICKER_PRESETS[0],
  icon: "",
};

/**
 * The status library. Rendered as its own settings tab, or `embedded` under
 * Settings → Workflows (MUL-7420), where each row also says how many
 * workflows use the status.
 */
export function IssueStatusesTab({
  embedded,
  workflowUsage,
}: {
  embedded?: { title: string };
  workflowUsage?: (statusKey: string) => number;
} = {}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();

  const [showArchived, setShowArchived] = useState(false);
  const [createGroup, setCreateGroup] = useState<IssueStatusGroup | null>(null);
  const [editing, setEditing] = useState<IssueStatusEntry | null>(null);
  const [pendingArchive, setPendingArchive] = useState<IssueStatusEntry | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [inspection, setInspection] = useState<{ workspaceId: string; status: IssueStatusEntry } | null>(null);
  const [inspectionOpen, setInspectionOpen] = useState(false);

  const { data: statuses = [], isLoading } = useQuery(issueStatusListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentUser = useAuthStore((s) => s.user);
  const myRole = useMemo(() => {
    if (!currentUser) return null;
    return members.find((m) => m.user_id === currentUser.id)?.role ?? null;
  }, [members, currentUser]);
  const isAdmin = myRole === "owner" || myRole === "admin";
  // The status a merge moves issues to is set on the Code page (MUL-7726);
  // its row carries a badge linking there.
  const mergeTarget = derivePRMergeStatus(useCurrentWorkspace());
  const mergeSettingsHref = settingsHref(navigation.pathname, navigation.searchParams, "code", {
    section: "pr-merge-status",
  });

  // Catalog order inside a group: category first, then position, so the ended
  // group lists done statuses before closed ones.
  const groups = useMemo(
    () =>
      STATUS_GROUP_ORDER.map((group) => ({
        group,
        // Archived rows are hidden behind a toggle rather than dropped: an
        // admin needs to see what a lingering status on an old issue is.
        entries: statuses
          .filter((s) => issueStatusGroup(s) === group && (showArchived || !s.archived_at))
          .sort(compareIssueStatusEntries),
      })),
    [statuses, showArchived],
  );

  // The server reorders one lifecycle category at a time and needs every active
  // status in it. Working and needs-attention share the started category, so a
  // drag in one group sends that group's new order followed or preceded by the
  // other group's current order.
  const categoryOrder = (
    category: IssueStatusCategory,
    group: IssueStatusGroup,
    nextGroupOrder: IssueStatusEntry[],
  ) =>
    groups
      .flatMap((g) => (g.group === group ? nextGroupOrder : g.entries))
      .filter((entry) => !entry.archived_at && normalizeIssueStatusCategory(entry.category) === category);

  // Moving a status to another group puts it after every started status, so
  // it lands at the end of its new group.
  const endOfStarted = Math.max(
    0,
    ...statuses
      .filter((s) => !s.archived_at && normalizeIssueStatusCategory(s.category) === "started")
      .map((s) => s.position),
  ) + 1;

  const archivedCount = statuses.filter((s) => !s.is_system && s.archived_at).length;

  const viewIssues = (status: IssueStatusEntry) => {
    setArchiveOpen(false);
    setInspection({ workspaceId: wsId, status });
    setInspectionOpen(true);
  };

  // Offered only once the workspace has something archived. A permanently
  // disabled "Show archived (0)" is a control that can never do anything.
  const archivedToggle = archivedCount > 0 ? (
    <label className="flex items-center justify-end gap-2 text-label text-muted-foreground">
      {t(($) => $.issue_statuses.show_archived, { count: archivedCount })}
      <Switch checked={showArchived} onCheckedChange={setShowArchived} />
    </label>
  ) : undefined;

  const body = (
    <>
      {myRole && !isAdmin ? <SettingsReadOnlyNotice wsId={wsId} /> : null}
      <div className="space-y-3">
        {isLoading ? (
          <div className="rounded-xl border border-surface-border bg-card px-4 py-12 text-center text-body text-muted-foreground">
            {t(($) => $.issue_statuses.loading)}
          </div>
        ) : (
          // 每个分组一张独立描边卡片，分组名在卡片上方。
          <div className="space-y-3">
            {groups.map((group) => (
              <GroupSection
                key={`${wsId}:${group.group}`}
                group={group.group}
                entries={group.entries}
                categoryOrder={categoryOrder}
                canManage={isAdmin}
                workflowUsage={workflowUsage}
                mergeTarget={mergeTarget}
                mergeSettingsHref={mergeSettingsHref}
                onCreate={() => setCreateGroup(group.group)}
                onEdit={(entry) => setEditing(entry)}
                onArchive={(entry) => {
                  setPendingArchive(entry); setArchiveOpen(true);
                }}
                onViewIssues={viewIssues}
              />
            ))}
          </div>
        )}
      </div>

      <StatusEditorDialog
        open={createGroup !== null}
        onOpenChange={(open) => !open && setCreateGroup(null)}
        group={createGroup}
        endOfStarted={endOfStarted}
      />
      <StatusEditorDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        group={editing ? issueStatusGroup(editing) : null}
        status={editing}
        endOfStarted={endOfStarted}
      />
      <ArchiveStatusDialog open={archiveOpen && pendingArchive?.workspace_id === wsId} status={pendingArchive} onClose={() => setArchiveOpen(false)} onViewIssues={viewIssues} />
      <Dialog open={inspectionOpen && inspection?.workspaceId === wsId} onOpenChange={setInspectionOpen} onOpenChangeComplete={(open) => !open && setInspection(null)}>
        <DialogContent className="flex h-[85dvh] flex-col overflow-hidden sm:max-w-6xl">
          {inspection?.workspaceId === wsId && <StatusIssueInspection key={`${wsId}:${inspection.status.key}`} status={inspection.status} onClose={() => setInspectionOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );

  return embedded ? (
    <section id="status-library" className="space-y-3">
      <div className="flex min-h-7 items-center gap-2.5">
        <h3 className="text-title font-bold">{embedded.title}</h3>
        {archivedToggle ? <div className="ml-auto">{archivedToggle}</div> : null}
      </div>
      {body}
    </section>
  ) : (
    <SettingsTab
      title={t(($) => $.page.tabs.issue_statuses)}
      description={isAdmin ? t(($) => $.issue_statuses.reorder_hint) : undefined}
      scope="workspace"
      actions={archivedToggle}
    >
      {body}
    </SettingsTab>
  );
}

function GroupSection({
  group,
  entries,
  categoryOrder,
  canManage,
  workflowUsage,
  mergeTarget,
  mergeSettingsHref,
  onCreate,
  onEdit,
  onArchive,
  onViewIssues,
}: {
  group: IssueStatusGroup;
  entries: IssueStatusEntry[];
  /** Every active status of one category, with this group's rows in their new order. */
  categoryOrder: (
    category: IssueStatusCategory,
    group: IssueStatusGroup,
    nextGroupOrder: IssueStatusEntry[],
  ) => IssueStatusEntry[];
  canManage: boolean;
  /** Badge the built-in Done row: PR auto-complete writes that status. */
  workflowUsage?: (statusKey: string) => number;
  mergeTarget: string;
  mergeSettingsHref: string;
  onCreate: () => void;
  onEdit: (status: IssueStatusEntry) => void;
  onArchive: (status: IssueStatusEntry) => void;
  onViewIssues: (status: IssueStatusEntry) => void;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  const reorder = useReorderIssueStatuses();
  const saving = useRef(false);

  // Local order so the drag reads as instant even before the optimistic cache
  // write settles; resynced whenever the server list changes.
  const [order, setOrder] = useState(entries);
  useEffect(() => setOrder(entries), [entries]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = (from: number, to: number) => {
    if (!canManage || saving.current || from < 0 || to < 0 || from === to ||
      !order[from] || !order[to] || order[from].archived_at || order[to].archived_at) return;
    // The ended group holds two lifecycle types; a row only moves among rows
    // of its own type, because the server orders one category at a time.
    const category = normalizeIssueStatusCategory(order[from].category);
    if (!category || category !== normalizeIssueStatusCategory(order[to].category)) return;
    const next = arrayMove(order, from, to);
    saving.current = true;
    setOrder(next);
    // ACTIVE rows only. With "show archived" on, `order` also holds archived
    // rows; sending those made the server reject the request, and before the
    // write became atomic that rejection landed AFTER the active rows had
    // already been reordered. Archived rows are frozen, so their absence from
    // the payload is also what the user sees.
    reorder.mutate(
      { category, ordered: categoryOrder(category, group, next) },
      {
        onError: (error) => {
          setOrder(entries);
          toast.error(
            error instanceof Error ? error.message : t(($) => $.issue_statuses.reorder_failed),
          );
        },
        onSettled: () => { saving.current = false; },
      },
    );
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    move(order.findIndex((s) => s.id === active.id), order.findIndex((s) => s.id === over.id));
  };

  // Only rows that can actually move are draggable. A single active status has
  // nothing to swap with, and archived rows are frozen.
  const sortableIds = order.filter((s) => !s.archived_at).map((s) => s.id);
  const canReorder = canManage && sortableIds.length > 1;

  return (
    <section
      aria-labelledby={`issue-status-group-${group}`}
      aria-busy={reorder.isPending}
    >
      {/* Label plus the one action the header owns. */}
      <div className="flex h-7.5 items-center justify-between gap-2 px-0.5">
        <h3
          id={`issue-status-group-${group}`}
          className="text-label font-normal text-muted-foreground"
        >
          {t(($) => $.issue_statuses.group_labels[group])}
        </h3>
        {canManage && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground [@media(pointer:coarse)]:size-11"
                  aria-label={`${t(($) => $.issue_statuses.add)}: ${t(($) => $.issue_statuses.group_labels[group])}`}
                  onClick={onCreate}
                >
                  <Plus className="size-4" />
                </Button>
              }
            />
            <TooltipContent>{t(($) => $.issue_statuses.add)}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="divide-y divide-surface-border overflow-hidden rounded-xl border border-surface-border bg-card">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {order.map((entry, index) => {
              // Rows this one may swap with: active, same lifecycle type.
              const peers = order.filter((s) => !s.archived_at && s.category === entry.category);
              const peerIndex = peers.findIndex((s) => s.id === entry.id);
              const canMove = canReorder && !reorder.isPending && peerIndex >= 0 && peers.length > 1;
              return (
                <StatusRow
                  key={entry.id}
                  entry={entry}
                  mergeBadgeHref={entry.key === mergeTarget && !entry.archived_at ? mergeSettingsHref : null}
                  label={entry.is_system ? labelOf(entry.key) : entry.name}
                  description={!entry.is_system
                    ? entry.description
                    : workflowUsage && !BEHAVIOR_STATUSES.has(entry.key)
                      ? ""
                      : t(($) => $.issue_statuses.built_in_descriptions[entry.key as BuiltInIssueStatus])}
                  canManage={canManage}
                  workflowUsage={entry.is_system ? undefined : workflowUsage?.(entry.key)}
                  showKey={Boolean(workflowUsage)}
                  canReorder={canReorder && !entry.archived_at && peers.length > 1}
                  isReordering={reorder.isPending}
                  onEdit={() => onEdit(entry)}
                  onArchive={() => onArchive(entry)}
                  onViewIssues={() => onViewIssues(entry)}
                  onMoveUp={canMove && peerIndex > 0
                    ? () => move(index, order.indexOf(peers[peerIndex - 1]!))
                    : undefined}
                  onMoveDown={canMove && peerIndex < peers.length - 1
                    ? () => move(index, order.indexOf(peers[peerIndex + 1]!))
                    : undefined}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}

function StatusRow({
  entry,
  mergeBadgeHref,
  label,
  description,
  canManage,
  workflowUsage,
  showKey,
  canReorder,
  isReordering,
  onEdit,
  onArchive,
  onViewIssues,
  onMoveUp,
  onMoveDown,
}: {
  entry: IssueStatusEntry;
  /** Where the "set when PRs merge" badge links, or null for no badge. */
  mergeBadgeHref: string | null;
  label: string;
  description: string;
  canManage: boolean;
  /** How many workflows list a custom status; undefined for built-ins and outside Workflows. */
  workflowUsage?: number;
  showKey: boolean;
  canReorder: boolean;
  isReordering: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onViewIssues: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const { t } = useT("settings");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !canReorder || isReordering,
  });

  const archived = Boolean(entry.archived_at);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/row relative flex min-h-12.5 items-center gap-3 bg-card py-2 pl-2 pr-2.5 motion-reduce:transition-none! ${isDragging ? "z-10 shadow-[var(--surface-shadow)]" : ""} ${archived ? "opacity-60" : ""}`}
    >
      {canReorder ? (
        <TooltipHint label={t(($) => $.issue_statuses.actions.reorder, { name: label })}>
          <button
            type="button"
            disabled={isReordering}
            aria-label={t(($) => $.issue_statuses.actions.reorder, { name: label })}
            className="flex h-6 w-5.5 shrink-0 touch-none items-center justify-center rounded-sm cursor-grab text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing [@media(pointer:coarse)]:size-11"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" />
          </button>
        </TooltipHint>
      ) : <span className="h-6 w-5.5 shrink-0 [@media(pointer:coarse)]:size-11" />}
      <StatusIcon
        status={entry.key}
        category={normalizeIssueStatusCategory(entry.category) ?? "unstarted"}
        color={issueStatusColor(entry)}
        icon={entry.icon}
        className="size-3.5 shrink-0"
      />
      {/* Name over description, the way the row is read: the name line keeps
          its badges, the description gets a line of its own. */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 truncate text-body font-medium">{label}</span>
          {showKey && (
            <span className="shrink-0 font-mono text-caption text-faint-foreground">{entry.key}</span>
          )}
          {mergeBadgeHref && (
            <AppLink
              href={mergeBadgeHref}
              className="inline-flex shrink-0 items-center gap-1 rounded-row bg-muted px-2 py-px text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Zap className="size-3" aria-hidden="true" />
              {t(($) => $.issue_statuses.pr_auto_complete_badge)}
            </AppLink>
          )}
          {archived && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="shrink-0 rounded-row bg-field px-2 py-px text-caption text-muted-foreground">
                    {t(($) => $.issue_statuses.archived_badge)}
                  </span>
                }
              />
              <TooltipContent>{t(($) => $.issue_statuses.archived_hint)}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {description && (
          <p className="min-w-0 truncate text-label text-muted-foreground">{description}</p>
        )}
      </div>
      {workflowUsage !== undefined && !archived && (
        <span className="shrink-0 whitespace-nowrap text-caption text-muted-foreground">
          {workflowUsage > 0
            ? t(($) => $.issue_statuses.workflow_usage, { count: workflowUsage })
            : t(($) => $.issue_statuses.workflow_usage_none)}
        </span>
      )}
      {/* The lifecycle type drives behavior; the group above is only where the
          row sits. Working and needs-attention rows both read Started. */}
      <span className="shrink-0 whitespace-nowrap rounded-full border border-surface-border px-2 py-px text-caption text-muted-foreground">
        {t(($) => $.issue_statuses.category_labels[normalizeIssueStatusCategory(entry.category) ?? "unstarted"])}
      </span>
      {/* Built-in is a quiet fact about the row, not a tag on the name. */}
      {showKey && entry.is_system && (
        <span className="shrink-0 whitespace-nowrap text-caption text-muted-foreground">
          {t(($) => $.issue_statuses.builtin_badge)}
        </span>
      )}
      {archived && <StatusIssuesButton variant="secondary" size="sm" onClick={onViewIssues} />}
      {canManage && !archived && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                variant="ghost"
                size="icon-sm"
                label={t(($) => $.issue_statuses.actions.open, { name: label })}
                className="shrink-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-popup-open:opacity-100 [@media(hover:hover)]:opacity-0 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!onMoveUp} onClick={onMoveUp}>
              <ArrowUp className="size-4" />
              {t(($) => $.issue_statuses.actions.move_up)}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!onMoveDown} onClick={onMoveDown}>
              <ArrowDown className="size-4" />
              {t(($) => $.issue_statuses.actions.move_down)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Built-ins drive system behavior, so their definition is locked.
                Say so where the actions are instead of offering them and
                refusing afterwards. */}
            <DropdownMenuItem disabled={entry.is_system} onClick={onEdit}>
              <Pencil className="size-4" />
              {t(($) => $.issue_statuses.actions.edit)}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={entry.is_system} onClick={onArchive}>
              <Archive className="size-4" />
              {t(($) => $.issue_statuses.actions.archive)}
            </DropdownMenuItem>
            {entry.is_system && (
              <p className="flex max-w-64 gap-1.5 px-2 pb-1 pt-1.5 text-caption leading-4 text-muted-foreground">
                <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                {t(($) => $.issue_statuses.built_in_locked)}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function StatusEditorDialog({
  open,
  onOpenChange,
  group,
  status,
  endOfStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group a new status is created in, or the edited status's group. */
  group: IssueStatusGroup | null;
  status?: IssueStatusEntry | null;
  /** A position after every started status, for a status that changes group. */
  endOfStarted: number;
}) {
  const { t } = useT("settings");
  const create = useCreateIssueStatus();
  const update = useUpdateIssueStatus();
  const [draft, setDraft] = useState<StatusDraft>(EMPTY_DRAFT);
  const [iconChanged, setIconChanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIconChanged(false);
    if (status) {
      setDraft({
        name: status.name,
        description: status.description ?? "",
        category: normalizeIssueStatusCategory(status.category) ?? "unstarted",
        group: issueStatusGroup(status),
        color: status.color,
        icon: ISSUE_STATUS_ICONS.includes(status.icon as IssueStatusIcon)
          ? status.icon as IssueStatusIcon : "",
      });
      return;
    }
    const createGroup = group ?? "not_started";
    setDraft({ ...EMPTY_DRAFT, group: createGroup, category: statusCategoriesForGroup(createGroup)[0]! });
  }, [status, group, open]);

  // A new status may pick among its group's lifecycle types; an existing one
  // keeps the type it was created with.
  const lifecycleOptions = status ? [draft.category] : statusCategoriesForGroup(draft.group);
  // Only a started custom status moves between working and needs attention.
  const canChangeGroup = Boolean(status) && draft.category === "started";

  const submit = () => {
    const name = draft.name.trim();
    if (!name || create.isPending || update.isPending) return;
    const onError = (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : t(($) => $.issue_statuses.editor.save_failed),
      );

    if (status) {
      const groupChanged = draft.group !== issueStatusGroup(status);
      update.mutate(
        {
          id: status.id,
          name,
          description: draft.description.trim(),
          color: draft.color,
          // Preserve an unknown future icon when only other fields are edited.
          ...(iconChanged ? { icon: draft.icon } : {}),
          ...(groupChanged ? { status_group: draft.group, position: endOfStarted } : {}),
        },
        { onSuccess: () => onOpenChange(false), onError },
      );
      return;
    }
    create.mutate(
      {
        name,
        description: draft.description.trim(),
        category: draft.category,
        status_group: draft.group,
        color: draft.color,
        icon: draft.icon,
      },
      {
        onSuccess: (created) => {
          onOpenChange(false);
          // The key is derived server-side and is the only handle the API and
          // the CLI accept, so creation has to say what it minted. A name with
          // no ASCII to slug gets one that cannot be guessed back from the name
          // — "客户确认" becomes `started_2` (MUL-6749) — so staying silent
          // would leave the admin no way to learn it short of reopening the
          // row. The dialog is already closing; a toast is the one surface
          // still visible.
          if (created?.key) {
            toast.success(t(($) => $.issue_statuses.editor.created, { key: created.key }));
          }
        },
        onError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-baseline gap-2">
              {status
                ? t(($) => $.issue_statuses.editor.edit_title)
                : t(($) => $.issue_statuses.editor.create_title)}
              <span className="text-label font-normal text-muted-foreground">
                {t(($) => $.issue_statuses.group_labels[draft.group])}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <FieldLabel htmlFor="status-name">
                {t(($) => $.issue_statuses.editor.name)}
              </FieldLabel>
              <Input
                id="status-name"
                type="text"
                autoComplete="off"
                data-1p-ignore
                autoFocus
                maxLength={64}
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder={t(($) => $.issue_statuses.editor.name_placeholder)}
              />
              {/* The key is the string the API and the CLI take, and renaming a
                  status does not move it — so it has to be readable somewhere.
                  Here, not as a chip on every row: the list is for scanning
                  names, and a slug beside each one is what turned it into a
                  table of internals. (MUL-6422) */}
              {status && (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.issue_statuses.editor.key_hint, { key: status.key })}
                </p>
              )}
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-caption font-medium">
                {t(($) => $.issue_statuses.editor.lifecycle)}
              </legend>
              {/* Immutable after creation: changing it would alter the
                  lifecycle of every issue already on this status. A group with
                  one lifecycle type shows that type alone. */}
              <div role="radiogroup" aria-label={t(($) => $.issue_statuses.editor.lifecycle)} className="flex flex-wrap gap-2">
                {lifecycleOptions.map((category) => {
                  const checked = draft.category === category;
                  const fixed = lifecycleOptions.length === 1;
                  return (
                    <button
                      key={category}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      disabled={fixed}
                      onClick={() => setDraft((current) => ({ ...current, category }))}
                      className={`flex h-8 items-center rounded-lg bg-field px-3 text-label transition-colors disabled:cursor-default ${checked ? "text-foreground" : "text-muted-foreground hover:bg-field-hover"} ${checked && !fixed ? "ring-2 ring-inset ring-faint-foreground" : ""}`}
                    >
                      {t(($) => $.issue_statuses.category_labels[category])}
                    </button>
                  );
                })}
              </div>
              {status && (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.issue_statuses.editor.lifecycle_locked)}
                </p>
              )}
            </fieldset>
            {canChangeGroup && (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-caption font-medium">
                  {t(($) => $.issue_statuses.editor.group)}
                </legend>
                <div role="radiogroup" aria-label={t(($) => $.issue_statuses.editor.group)} className="grid grid-cols-2 gap-0.5 rounded-lg bg-field p-0.5">
                  {(["working", "needs_attention"] as const).map((option) => {
                    const checked = draft.group === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        onClick={() => setDraft((current) => ({ ...current, group: option }))}
                        className={`h-7 rounded-md text-label transition-colors ${checked ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {t(($) => $.issue_statuses.group_labels[option])}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <div className="space-y-2">
              <FieldLabel htmlFor="status-description">
                {t(($) => $.issue_statuses.editor.description)}
              </FieldLabel>
              <Textarea
                id="status-description"
                rows={3}
                maxLength={256}
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={t(($) => $.issue_statuses.editor.description_placeholder)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel>{t(($) => $.issue_statuses.editor.color)}</FieldLabel>
              <ColorPicker
                value={draft.color}
                onChange={(color) => setDraft((current) => ({ ...current, color }))}
                trigger={
                  <button
                    type="button"
                    aria-label={t(($) => $.issue_statuses.editor.color)}
                    className="flex h-8 items-center gap-2.5 rounded-lg bg-field px-2.5 transition-colors hover:bg-field-hover"
                  >
                    <StatusIcon
                      status={status?.key ?? ""}
                      category={draft.category}
                      color={draft.color}
                      icon={draft.icon}
                      className="size-5"
                    />
                    <span className="font-mono text-caption uppercase text-muted-foreground">
                      {draft.color}
                    </span>
                  </button>
                }
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-caption font-medium">
                {t(($) => $.issue_statuses.editor.icon)}
              </legend>
              <div className="flex flex-wrap gap-2">
                {(["", ...ISSUE_STATUS_ICONS] as const).map((icon) => (
                  <TooltipHint key={icon} label={icon ? t(($) => $.issue_statuses.editor.icon_shapes[icon]) : undefined}>
                    <Button
                      type="button"
                      variant={draft.icon === icon ? "secondary" : "outline"}
                      size={icon ? "icon" : "default"}
                      className={`${icon ? "size-11" : "h-11"} aria-pressed:ring-2 aria-pressed:ring-ring`}
                      aria-label={t(($) => $.issue_statuses.editor.icon_shapes[icon || "default"])}
                      aria-pressed={draft.icon === icon}
                      onClick={() => {
                        setIconChanged(true);
                        setDraft((current) => ({ ...current, icon }));
                      }}
                    >
                      {icon
                        ? <StatusIcon status="" category={draft.category} color={draft.color} icon={icon} className="size-5" />
                        : t(($) => $.issue_statuses.editor.icon_shapes.default)}
                    </Button>
                  </TooltipHint>
                ))}
              </div>
            </fieldset>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t(($) => $.issue_statuses.editor.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={!draft.name.trim() || create.isPending || update.isPending}
            >
              {create.isPending || update.isPending
                ? t(($) => $.issue_statuses.editor.saving)
                : t(($) => $.issue_statuses.editor.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatusIssueInspection({ status, onClose }: { status: IssueStatusEntry; onClose: () => void }) {
  const { t } = useT("settings");
  const [store] = useState(() => createIssueStatusListStore(status.key));
  const baseline = useMemo(() => baselineFromQuery({ statusFilters: [status.key] }), [status.key]);
  return <>
    <DialogHeader>
      <DialogTitle>{status.name}</DialogTitle>
      <Button variant="ghost" className="self-start" onClick={onClose}>
        <ArrowLeft />{t(($) => $.issue_statuses.title)}
      </Button>
    </DialogHeader>
    <IssueSurfaceWithStore store={store} baseline={baseline} scope={{ type: "workspace", actorKind: "all" }} modes={["list"]} renderHeader={() => null} batchToolbar="always" />
  </>;
}

function StatusIssuesButton({ onClick, variant = "default", size = "default", disabled = false }: { onClick: () => void; variant?: "default" | "outline" | "secondary"; size?: "default" | "sm"; disabled?: boolean }) {
  const { t } = useT("settings");
  return <Button variant={variant} size={size} disabled={disabled} onClick={onClick}>{t(($) => $.issue_statuses.archive_dialog.view_issues)}</Button>;
}

function ArchiveStatusDialog({
  status,
  open,
  onClose,
  onViewIssues,
}: {
  status: IssueStatusEntry | null;
  open: boolean;
  onClose: () => void;
  onViewIssues: (status: IssueStatusEntry) => void;
}) {
  const { t } = useT("settings");
  const archive = useArchiveIssueStatus();
  const [issueCount, setIssueCount] = useState<number | null>(null);
  useEffect(() => {
    if (open) setIssueCount(null);
  }, [open, status?.id]);
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && !archive.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{issueCount !== null
            ? t(($) => $.issue_statuses.archive_dialog.in_use_title)
            : t(($) => $.issue_statuses.archive_dialog.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {issueCount !== null ? t(($) => $.issue_statuses.archive_dialog.in_use, { count: issueCount }) : t(($) => $.issue_statuses.archive_dialog.description, {
              name: status?.name ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>
            {t(($) => $.issue_statuses.archive_dialog.cancel)}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={issueCount !== null ? "outline" : "default"}
            disabled={archive.isPending}
            onClick={() => {
              if (!status) return;
              archive.mutate(status.id, {
                onSuccess: onClose,
                onError: (error) => {
                  const count = issueStatusArchiveConflictCount(error);
                  if (count !== null) {
                    setIssueCount(count);
                    return;
                  }
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t(($) => $.issue_statuses.archive_dialog.failed),
                  );
                },
              });
            }}
          >
            {archive.isPending ? t(($) => $.issue_statuses.archive_dialog.archiving) : issueCount !== null ? t(($) => $.issue_statuses.archive_dialog.retry) : t(($) => $.issue_statuses.archive_dialog.confirm)}
          </AlertDialogAction>
          {issueCount !== null && status && <StatusIssuesButton disabled={archive.isPending} onClick={() => onViewIssues(status)} />}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
