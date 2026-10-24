"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, Ban, ChevronDown, ChevronRight, Focus, Plus } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useReducedMotion } from "motion/react";
import type { Issue, IssueStatus, Project } from "@marvis/core/types";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useIssueStatuses } from "@marvis/core/issue-statuses/hooks";
import {
  groupStatusesIntoBoardColumns,
  isBoardLaneCollapsed,
  type BoardStatusColumnKey,
} from "@marvis/core/issues";
import { useViewStore, useViewStoreApi } from "@marvis/core/issues/stores/view-store-context";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { ActorAvatar } from "../../common/actor-avatar";
import { DeferredTooltip } from "../../common/deferred-tooltip";
import { useRestoredScrollRef } from "../../platform";
import { ColumnHandoff } from "../../workflows/column-handoff";
import type { IssueCreateDefaults } from "../surface/types";
import type { IssueStatusPagination } from "../surface/use-issue-status-branches";
import { useStatusLabel } from "../utils/status-label";
import type { BoardColumnGroup } from "./board-column";
import { DraggableBoardCard } from "./board-card";
import { useBoardWorkflow } from "./board-workflow-context";
import { ListLoadMoreFooter } from "./list-load-more-footer";
import type { ChildProgress } from "./list-row";
import { StatusIcon } from "./status-icon";

/** Cards a lane shows before its "N more" button. */
export const LANE_PREVIEW_COUNT = 4;

// Four equal columns. The minimum only bites on narrow viewports, where the
// board scroller falls back to horizontal scrolling instead of crushing the
// cards.
const STATUS_BOARD_GRID_TEMPLATE = "repeat(4, minmax(240px, 1fr))";

const EMPTY_IDS: string[] = [];
const EMPTY_COLLAPSE: Record<string, boolean> = {};

export type StatusGroup = BoardColumnGroup & { status: IssueStatus };

export type LaneMode = "normal" | "focused" | "pinned";

export interface LaneSharedProps {
  columns: Record<string, string[]>;
  issueMap: Map<string, Issue>;
  childProgressMap?: Map<string, ChildProgress>;
  projectMap?: Map<string, Project>;
  statusPagination?: IssueStatusPagination;
  projectId?: string;
  onCreateIssue?: (defaults: IssueCreateDefaults) => void;
  sortLabel?: string | null;
  /** The card being dragged, kept visible even past a lane's preview cut. */
  activeIssueId?: string | null;
}

/**
 * The status-grouped board: four fixed columns, one per status group (not
 * started / working / needs attention / ended), each stacking one lane per
 * visible status. Lanes
 * keep the per-status droppable ids of the classic board, so the board's drag
 * handlers and column mirror work unchanged.
 */
export const StatusLaneBoard = memo(function StatusLaneBoard({
  groups,
  ...shared
}: LaneSharedProps & { groups: StatusGroup[] }) {
  const wsId = useWorkspaceId();
  const { groupOf } = useIssueStatuses(wsId);

  const boardColumns = useMemo(() => {
    const byStatus = new Map(groups.map((group) => [group.status, group]));

    return groupStatusesIntoBoardColumns(
      groups.map((group) => group.status),
      groupOf,
    ).map((column) => ({
      key: column.key,
      groups: column.statuses.flatMap((status) => {
        const group = byStatus.get(status);
        return group ? [group] : [];
      }),
    }));
  }, [groups, groupOf]);

  return (
    <div
      data-status-lane-board=""
      className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3"
      style={{ gridTemplateColumns: STATUS_BOARD_GRID_TEMPLATE }}
    >
      {boardColumns.map((column) => (
        <StatusBoardColumn
          key={column.key}
          columnKey={column.key}
          groups={column.groups}
          {...shared}
        />
      ))}
    </div>
  );
});

function laneCount(
  group: StatusGroup,
  columns: Record<string, string[]>,
  statusPagination?: IssueStatusPagination,
): number {
  return statusPagination?.[group.status]?.total ?? (columns[group.id] ?? EMPTY_IDS).length;
}

/**
 * Focus mode for a stack of status lanes: one lane takes the stack and the
 * others pin below it. Esc leaves focus mode, unless something else (a
 * dialog, a menu) already handled the key.
 */
export function useFocusedLane(groups: StatusGroup[]) {
  const [focusedStatus, setFocusedStatus] = useState<IssueStatus | null>(null);
  const focused = focusedStatus !== null && groups.some((group) => group.status === focusedStatus)
    ? focusedStatus
    : null;

  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setFocusedStatus(null);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focused]);

  return [focused, setFocusedStatus] as const;
}

function StatusBoardColumn({
  columnKey,
  groups,
  ...shared
}: LaneSharedProps & { columnKey: BoardStatusColumnKey; groups: StatusGroup[] }) {
  const { t } = useT("issues");
  const [focused, setFocusedStatus] = useFocusedLane(groups);
  const total = groups.reduce(
    (sum, group) => sum + laneCount(group, shared.columns, shared.statusPagination),
    0,
  );
  const title = t(($) => $.board.status_column[columnKey]);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const restoreScrollRef = useRestoredScrollRef(`board:column:${columnKey}`);
  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      setScrollEl(el);
      restoreScrollRef(el);
    },
    [restoreScrollRef],
  );

  const scrollLanes = focused ? groups.filter((group) => group.status === focused) : groups;
  const pinnedLanes = focused ? groups.filter((group) => group.status !== focused) : [];

  return (
    <section
      aria-label={title}
      data-board-status-column={columnKey}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 px-2">
        <h2 className="truncate text-body font-semibold">{title}</h2>
        <span className="shrink-0 text-label tabular-nums text-faint-foreground">{total}</span>
        {focused && (
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-caption font-medium text-brand">
              {t(($) => $.board.focusing)}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="rounded-full text-muted-foreground"
              onClick={() => setFocusedStatus(null)}
            >
              {t(($) => $.board.exit_focus)}
            </Button>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col rounded-[16px] bg-surface-sunken p-1.5">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-tab-scroll-root={`board:column:${columnKey}`}
            className="absolute inset-0 overflow-y-auto"
          >
            <div className="flex flex-col gap-1.5">
              {groups.length === 0 ? (
                <p className="py-8 text-center text-label text-muted-foreground">
                  {t(($) => $.board.empty_column)}
                </p>
              ) : (
                scrollLanes.map((group) => (
                  <StatusLane
                    key={group.id}
                    group={group}
                    mode={focused ? "focused" : "normal"}
                    onFocusChange={setFocusedStatus}
                    {...shared}
                  />
                ))
              )}
            </div>
          </div>
          <BelowFoldPill scrollEl={scrollEl} />
        </div>
        {pinnedLanes.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1 border-t border-border/60 pt-1.5">
            {pinnedLanes.map((group) => (
              <StatusLane
                key={group.id}
                group={group}
                mode="pinned"
                onFocusChange={setFocusedStatus}
                {...shared}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export const StatusLane = memo(function StatusLane({
  group,
  mode,
  onFocusChange,
  columns,
  issueMap,
  childProgressMap,
  projectMap,
  statusPagination,
  projectId,
  onCreateIssue,
  sortLabel,
  activeIssueId,
}: LaneSharedProps & {
  group: StatusGroup;
  mode: LaneMode;
  onFocusChange: (status: IssueStatus | null) => void;
}) {
  const { t } = useT("issues");
  const status = group.status;
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  const { categoryOf, colorOf, iconOf, entryOf } = useIssueStatuses(wsId);
  const archived = !!entryOf(status)?.archived_at;
  const label = labelOf(status);

  const issueIds = columns[group.id] ?? EMPTY_IDS;
  const page = statusPagination?.[status];
  const count = page?.total ?? issueIds.length;

  const savedCollapse = useViewStore((s) => s.boardLaneCollapsed) ?? EMPTY_COLLAPSE;
  const viewStoreApi = useViewStoreApi();
  const collapsed =
    mode === "pinned" ||
    (mode === "normal" &&
      isBoardLaneCollapsed({ category: categoryOf(status), count, saved: savedCollapse[status] }));

  // "N more" expansion is ephemeral: it resets on remount, unlike collapse.
  const [expanded, setExpanded] = useState(false);
  const showAll = mode === "focused" || expanded;
  // Cards from this index on were revealed by "N more" and fade in.
  const [revealFrom, setRevealFrom] = useState<number | null>(null);

  const { setNodeRef, isOver: droppableIsOver } = useDroppable({ id: group.id });
  const { dropBlockedReason, dropHint } = useBoardWorkflow();
  const blockedReason = dropBlockedReason(status);
  const isOver = droppableIsOver && !archived && !blockedReason;
  const hint = isOver ? dropHint(status) : null;

  const visibleIds = useMemo(() => {
    if (collapsed) return EMPTY_IDS;
    if (showAll) return issueIds;

    const preview = issueIds.slice(0, LANE_PREVIEW_COUNT);
    // A card dragged into this lane lands at its end; keep it on screen.
    if (activeIssueId && !preview.includes(activeIssueId) && issueIds.includes(activeIssueId)) {
      preview.push(activeIssueId);
    }

    return preview;
  }, [activeIssueId, collapsed, issueIds, showAll]);

  const hiddenCount = Math.max(0, count - visibleIds.length);
  // A server-paged lane may not have its first rows yet; the footer's
  // sentinel fetches them, so it mounts until the preview is filled.
  const fillingPreview = !collapsed && !!page?.hasMore && issueIds.length < LANE_PREVIEW_COUNT;

  const expand = () => {
    setExpanded(true);
    setRevealFrom(visibleIds.length);
    // A server-paged lane may hold only the preview so far; fetch the next
    // page right away instead of waiting for the end-of-lane sentinel.
    if (page?.hasMore && !page.isFetching && issueIds.length <= LANE_PREVIEW_COUNT) {
      page.loadMore();
    }
  };

  const collapseExpansion = () => {
    setExpanded(false);
    setRevealFrom(null);
  };

  const toggleCollapsed = () => {
    if (mode === "pinned") {
      onFocusChange(status);
      return;
    }
    viewStoreApi.getState().setBoardLaneCollapsed(status, !collapsed);
  };

  const create = () => {
    onCreateIssue?.({
      ...(group.createData ?? {}),
      ...(projectId ? { project_id: projectId } : {}),
    });
  };

  return (
    <div
      ref={setNodeRef}
      data-board-lane={status}
      data-lane-mode={mode}
      className={cn(
        "relative rounded-xl transition-colors duration-(--motion-fast) ease-out",
        isOver && !sortLabel && "bg-surface-hover",
        hint && "ring-2 ring-brand/30",
      )}
    >
      {blockedReason && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background/60 bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--color-border)_8px_9px)]"
        >
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-caption text-muted-foreground shadow-control">
            <Ban className="size-3" />
            {blockedReason}
          </span>
        </div>
      )}
      <div
        className={cn(
          "group/lane flex h-[30px] items-center gap-1.5 rounded-lg pr-0.5 pl-1",
          // Sticky inside the lane, so the next lane's header pushes it out.
          mode !== "pinned" && "sticky top-0 z-10 bg-surface-sunken",
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={label}
          disabled={count === 0 && mode !== "pinned"}
          onClick={toggleCollapsed}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform duration-(--motion-fast)",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-label font-medium">
          <StatusIcon
            category={categoryOf(status)}
            color={colorOf(status)}
            icon={iconOf(status)}
            status={status}
            className="size-3.5 shrink-0"
          />
          <span className={cn("truncate", count === 0 && "text-faint-foreground")}>{label}</span>
        </span>
        <span className="shrink-0 text-caption tabular-nums text-faint-foreground">{count}</span>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5">
          {expanded && mode === "normal" && (
            <Button
              variant="ghost"
              size="xs"
              className="h-6 rounded-full px-2 text-muted-foreground"
              onClick={collapseExpansion}
            >
              {t(($) => $.board.lane_collapse)}
            </Button>
          )}
          <LaneHandoffBadge status={status} />
          <DeferredTooltip
            content={
              mode === "focused"
                ? t(($) => $.board.exit_focus)
                : t(($) => $.board.lane_focus, { status: label })
            }
            trigger={
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "size-6 rounded-full text-muted-foreground",
                  mode === "focused" && "text-brand",
                )}
                aria-pressed={mode === "focused"}
                aria-label={t(($) => $.board.lane_focus, { status: label })}
                onClick={() => onFocusChange(mode === "focused" ? null : status)}
              >
                <Focus className="size-3.5" />
              </Button>
            }
          />
          {onCreateIssue && !archived && (
            <DeferredTooltip
              content={t(($) => $.board.add_issue_tooltip)}
              trigger={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 rounded-full text-muted-foreground"
                  aria-label={t(($) => $.board.add_issue_tooltip)}
                  onClick={create}
                >
                  <Plus className="size-3.5" />
                </Button>
              }
            />
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="relative px-0.5 pt-1.5 pb-1">
          {isOver && sortLabel && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/40">
              <span className="rounded-full border border-border bg-popover px-2.5 py-1 text-caption font-medium text-popover-foreground shadow-control">
                {sortLabel}
              </span>
            </div>
          )}
          <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {visibleIds.map((id, index) => {
                const issue = issueMap.get(id);
                if (!issue) return null;

                return (
                  <div
                    key={id}
                    className={cn(
                      revealFrom !== null &&
                        index >= revealFrom &&
                        "animate-in fade-in slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none",
                    )}
                  >
                    <DraggableBoardCard
                      issue={issue}
                      childProgress={childProgressMap?.get(id)}
                      project={issue.project_id ? projectMap?.get(issue.project_id) : undefined}
                      disableSorting={!!sortLabel}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
          {hint && (
            <div className="pointer-events-none mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand/50 bg-card px-3 py-2 text-caption text-muted-foreground">
              {hint.actor && <ActorAvatar actorType={hint.actor.type} actorId={hint.actor.id} size="xs" profileLink={false} />}
              <span className="truncate">
                {hint.run
                  ? t(($) => $.workflows.board.drop_hint_run, { name: hint.name })
                  : t(($) => $.workflows.board.drop_hint, { name: hint.name })}
              </span>
            </div>
          )}
          {!showAll && !fillingPreview && hiddenCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1 w-full rounded-lg text-muted-foreground"
              onClick={expand}
            >
              {t(($) => $.board.lane_more, { count: hiddenCount })}
              <ChevronDown className="size-3" />
            </Button>
          )}
          {page && (showAll || fillingPreview) && (
            <ListLoadMoreFooter
              hasMore={page.hasMore}
              isLoading={page.isLoading || page.isFetching}
              total={page.total}
              onLoadMore={page.loadMore}
              isError={page.isError}
              onRetry={page.retry}
            />
          )}
        </div>
      )}
    </div>
  );
});

/** On a project board, the lane's workflow handoff for that project. */
function LaneHandoffBadge({ status }: { status: string }) {
  const { scopeWorkflow, scopeProject } = useBoardWorkflow();
  if (!scopeWorkflow || !scopeProject) return null;

  return <ColumnHandoff status={status} workflow={scopeWorkflow} project={scopeProject} />;
}

/**
 * Counts the cards still below the visible part of a column's scroll area.
 * Recomputed on scroll and whenever the area or its content resizes.
 */
function useCardsBelowFold(scrollEl: HTMLElement | null): number {
  const [below, setBelow] = useState(0);

  useEffect(() => {
    if (!scrollEl) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
      if (atBottom) {
        setBelow(0);
        return;
      }
      const fold = scrollEl.getBoundingClientRect().bottom;
      let count = 0;
      for (const card of scrollEl.querySelectorAll("[data-board-card]")) {
        if (card.getBoundingClientRect().top >= fold - 8) count += 1;
      }
      setBelow(count);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(scrollEl);
    if (scrollEl.firstElementChild) resize?.observe(scrollEl.firstElementChild);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollEl.removeEventListener("scroll", schedule);
      resize?.disconnect();
    };
  }, [scrollEl]);

  return below;
}

function BelowFoldPill({ scrollEl }: { scrollEl: HTMLElement | null }) {
  const { t } = useT("issues");
  const below = useCardsBelowFold(scrollEl);
  const reducedMotion = useReducedMotion() ?? false;

  if (!scrollEl || below === 0) return null;

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface-sunken to-transparent"
      />
      <button
        type="button"
        onClick={() =>
          scrollEl.scrollBy({
            top: scrollEl.clientHeight * 0.8,
            behavior: reducedMotion ? "auto" : "smooth",
          })
        }
        className="absolute bottom-2 left-1/2 z-20 flex h-7 -translate-x-1/2 items-center gap-1 rounded-full bg-foreground px-3 text-caption font-medium whitespace-nowrap text-background shadow-control animate-in fade-in duration-200 motion-reduce:animate-none"
      >
        <ArrowDown className="size-3" />
        {t(($) => $.board.below_fold, { count: below })}
      </button>
    </>
  );
}
