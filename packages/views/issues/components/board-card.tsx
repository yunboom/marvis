"use client";

import { useCallback, useEffect, useState, memo, type ReactNode } from "react";
import { AppLink } from "../../navigation";
import type { DropAnimation } from "@dnd-kit/core";
import { useSortable, defaultAnimateLayoutChanges } from "@dnd-kit/sortable";
import type { AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@marvis/ui/lib/utils";
import type { Issue, IssueProperty, Project, UpdateIssueRequest } from "@marvis/core/types";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { propertyListOptions } from "@marvis/core/properties";
import { CustomPropertyValueDisplay } from "./pickers/custom-property-picker";
import { descriptionPreview } from "./description-preview";
import { dateOnlyToUTCDate, formatDateOnly, todayDateOnly } from "@marvis/core/issues/date";
import { useIssueStatuses } from "@marvis/core/issue-statuses/hooks";
import { Folder } from "lucide-react";
import { ActorAvatar } from "../../common/actor-avatar";
import { PropertyIcon } from "../../common/property-icon";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import { useLocale, useT, useTimeAgo } from "../../i18n";
import { PriorityIcon } from "./priority-icon";
import { PriorityPicker, AssigneePicker, StartDatePicker, DueDatePicker } from "./pickers";
import { useViewStore } from "@marvis/core/issues/stores/view-store-context";
import { propertyIdFromViewKey } from "@marvis/core/issues/stores/view-store";
import { ProgressRing } from "./progress-ring";
import type { ChildProgress } from "./list-row";
import { IssueActionsContextMenu } from "../actions";
import { IssueAgentActivityIndicator } from "./issue-agent-activity-indicator";
import { CustomStatusChip, useIsCustomStatus } from "./custom-status-chip";
import { IssueDuplicateOfMarker } from "./issue-duplicates";
import { useIssueSurfaceActionsOptional } from "../surface/actions-context";
import {
  PEEK_TARGET_ATTR,
  useIsIssuePeeked,
  useIssuePeekActions,
  useIssuePeekLinkProps,
} from "../surface/peek-context";
function formatDate(date: string, locale: string): string {
  return formatDateOnly(date, { month: "short", day: "numeric" }, locale);
}

// Board card: borderless white card held by a hairline shadow ring. Hover and an
// open popup deepen the ring; the peeked ring composes with it, so a selected
// card stays identifiable while hovered. Keyboard focus on the draggable
// wrapper or its link draws the same rounded ring in the focus color (the
// wrapper's own outline would be a square box around the card); the peeked
// color wins when both apply.
const BOARD_CARD_SURFACE =
  "rounded-[12px] bg-card px-3.5 py-3 shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.04)] transition-shadow duration-(--motion-fast) ease-out dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] group-hover/card:shadow-[0_0_0_1px_rgb(0_0_0/0.09),0_1px_3px_rgb(0_0_0/0.06)] group-hover/card:duration-(--motion-instant) group-data-[popup-open]/card:shadow-[0_0_0_1px_rgb(0_0_0/0.09),0_1px_3px_rgb(0_0_0/0.06)] dark:group-hover/card:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] dark:group-data-[popup-open]/card:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] group-focus-visible/card:ring-[1.5px] group-focus-visible/card:ring-ring group-has-[>a:focus-visible]/card:ring-[1.5px] group-has-[>a:focus-visible]/card:ring-ring group-data-[peeked]/card:ring-[1.5px] group-data-[peeked]/card:ring-foreground!";

// Inline meta item on the project / labels line: plain muted text, no pill.
const BOARD_CARD_META_ITEM = "inline-flex min-w-0 items-center gap-1";

// Footer separator between the date group and child progress.
const FOOTER_SEPARATOR = " · ";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar days a date-only value lies before today; 0 when not past. */
function daysOverdue(value: string | null | undefined): number {
  const due = dateOnlyToUTCDate(value);
  const today = dateOnlyToUTCDate(todayDateOnly());
  if (!due || !today) return 0;

  return Math.max(0, Math.round((today.getTime() - due.getTime()) / DAY_MS));
}

// 拖拽动效（Motion「看板拖拽」）：让位 200ms ease-standard；落位 200ms ease-spring。
// 落位走 Web Animations，easing 不能写 var()，这里与 tokens.css 的 --ease-spring 保持同值。
export const DRAG_SHIFT_TRANSITION = { duration: 200, easing: "var(--ease-standard)" };
const DROP_DURATION_MS = 200;
const DROP_EASE_SPRING = "cubic-bezier(0.34, 1.28, 0.64, 1)";
const DROP_EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const DRAG_LIFT_ATTR = "data-drag-lift";

/**
 * 看板与列表拖拽浮层共用的落位动画：浮层飞回卡片原位，同时收回抬起的放大、倾斜和阴影。
 * 减少动态效果时保留位移，去掉回弹。
 */
export function issueDropAnimation(reducedMotion: boolean): DropAnimation {
  const easing = reducedMotion ? DROP_EASE_OUT : DROP_EASE_SPRING;
  return {
    duration: DROP_DURATION_MS,
    easing,
    sideEffects: (params) => {
      // 落位期间隐藏原位占位，避免与浮层重影；结束后恢复
      const source = params.active.node;
      const previousOpacity = source.style.opacity;
      source.style.opacity = "0";

      // 落位时把抬起的放大、倾斜和浮起阴影一并收回
      const lift = params.dragOverlay.node.querySelector<HTMLElement>(`[${DRAG_LIFT_ATTR}]`);
      if (lift) {
        lift.style.transitionDuration = `${DROP_DURATION_MS}ms`;
        lift.style.transitionTimingFunction = easing;
        lift.style.scale = "1";
        lift.style.rotate = "0deg";
        lift.style.boxShadow = "none";
      }

      return () => {
        source.style.opacity = previousOpacity;
      };
    },
  };
}

/**
 * DragOverlay 里被拖起的卡片外观：150ms 抬起到 scale 1.02、倾斜 1.5° 并带浮起阴影，卡片保持不透明。
 */
export function DragLift({ children, className }: { children: ReactNode; className?: string }) {
  const [lifted, setLifted] = useState(false);

  // 首帧以静止态挂载，下一帧再切到抬起态，过渡才会生效
  useEffect(() => {
    const frame = requestAnimationFrame(() => setLifted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      {...{ [DRAG_LIFT_ATTR]: "" }}
      data-lifted={lifted ? "" : undefined}
      className={cn(
        "cursor-grabbing rounded-[12px] transition-[scale,rotate,box-shadow] duration-(--motion-fast) ease-out motion-reduce:transition-none data-[lifted]:scale-[1.02] data-[lifted]:rotate-[1.5deg] data-[lifted]:shadow-menu",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Stops event from bubbling to Link/drag handlers */
function PickerWrapper({ children, className }: { children: React.ReactNode; className?: string }) {
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div onClick={stop} onMouseDown={stop} onPointerDown={stop} className={className}>
      {children}
    </div>
  );
}

export const BoardCardContent = memo(function BoardCardContent({
  issue,
  editable = false,
  childProgress,
  project,
}: {
  issue: Issue;
  editable?: boolean;
  childProgress?: ChildProgress;
  project?: Project;
}) {
  const { t } = useT("issues");
  const locale = useLocale();
  const timeAgo = useTimeAgo();
  const storeProperties = useViewStore((s) => s.cardProperties);
  const cardPropertyIds = useViewStore((s) => s.cardPropertyIds);
  const viewMode = useViewStore((s) => s.viewMode);
  const grouping = useViewStore((s) => s.grouping);
  const swimlaneGrouping = useViewStore((s) => s.swimlaneGrouping);
  const cardGrouping =
    viewMode === "board"
      ? grouping
      : viewMode === "swimlane"
        ? swimlaneGrouping
        : null;
  const groupedPropertyId = cardGrouping
    ? propertyIdFromViewKey(cardGrouping)
    : null;
  const cardWsId = useWorkspaceId();
  const { data: workspaceProperties = [] } = useQuery(propertyListOptions(cardWsId));
  // Custom properties toggled on in Display options, in toggle order, only
  // when this issue actually carries a value.
  const cardCustomProperties = cardPropertyIds
    .filter((id) => id !== groupedPropertyId)
    .map((id) => workspaceProperties.find((p) => p.id === id))
    .filter((p): p is IssueProperty => !!p && issue.properties?.[p.id] !== undefined);
  const labels = issue.labels ?? [];

  const surfaceActions = useIssueSurfaceActionsOptional();
  const handleUpdate = useCallback(
    (updates: Partial<UpdateIssueRequest>) => {
      surfaceActions?.updateIssue(issue.id, updates, {
        errorMessage: t(($) => $.card.update_failed),
      });
    },
    [issue.id, surfaceActions, t],
  );
  const canEdit = editable && !!surfaceActions;

  const hasAssignee = !!issue.assignee_type && !!issue.assignee_id;
  const showPriority = storeProperties.priority && issue.priority !== "none";
  const showDescription = storeProperties.description && issue.description;
  const showAssigneeSection =
    storeProperties.assignee && cardGrouping !== "assignee" && hasAssignee;
  const showStartDate = storeProperties.startDate && issue.start_date;
  const showDueDate = storeProperties.dueDate && issue.due_date;
  const showProject =
    storeProperties.project && cardGrouping !== "project" && project;
  const showChildProgress = storeProperties.childProgress && childProgress;
  const showLabels = storeProperties.labels && labels.length > 0;
  // Keeps the chip row from rendering an empty flex container when the status
  // chip is the only thing in it and it decides to render nothing.
  const showCustomStatus = useIsCustomStatus(issue.status);

  const { getActorName } = useActorName();
  const assigneeName =
    showAssigneeSection && issue.assignee_type && issue.assignee_id
      ? getActorName(issue.assignee_type, issue.assignee_id)
      : null;

  const statusCatalog = useIssueStatuses(cardWsId);
  const statusCategory = statusCatalog.categoryOf(issue.status);
  const isFinished = statusCategory === "done" || statusCategory === "closed";

  const priorityLabel = t(($) => $.priority[issue.priority]);
  const priorityIconNode = showPriority ? (
    canEdit ? (
      <PickerWrapper className="flex">
        <PriorityPicker
          priority={issue.priority}
          onUpdate={handleUpdate}
          tooltip={priorityLabel}
          triggerRender={
            <button
              type="button"
              aria-label={priorityLabel}
              className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-xs transition-colors duration-(--motion-fast) hover:bg-accent"
            >
              <PriorityIcon priority={issue.priority} />
            </button>
          }
        />
      </PickerWrapper>
    ) : (
      <span
        aria-label={priorityLabel}
        className="inline-flex size-4.5 shrink-0 items-center justify-center"
      >
        <PriorityIcon priority={issue.priority} />
      </span>
    )
  ) : null;

  const assigneeInner = hasAssignee ? (
    <span className="flex min-w-0 max-w-[150px] items-center gap-1.5">
      <ActorAvatar
        actorType={issue.assignee_type!}
        actorId={issue.assignee_id!}
        size="xs"
        enableHoverCard
        profileLink={false}
        className="shrink-0"
      />
      {assigneeName && (
        <span className="min-w-0 truncate text-caption text-muted-foreground">{assigneeName}</span>
      )}
    </span>
  ) : null;

  const assigneeNode = showAssigneeSection ? (
    canEdit ? (
      <PickerWrapper className="flex min-w-0 items-center">
        <AssigneePicker
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          onUpdate={handleUpdate}
          trigger={assigneeInner}
        />
      </PickerWrapper>
    ) : (
      <span className="flex min-w-0 items-center">{assigneeInner}</span>
    )
  ) : null;

  // Dates: "start – due" when both are on and set; an overdue due date reads as
  // "N days overdue" in the urgent colour and replaces the range.
  const overdueDays = showDueDate ? daysOverdue(issue.due_date) : 0;
  const isOverdue = overdueDays > 0;
  const showStartInFooter = !!showStartDate && !isOverdue;

  const startText = showStartInFooter ? formatDate(issue.start_date!, locale) : null;
  const startNode = startText ? (
    canEdit ? (
      <PickerWrapper className="flex shrink-0">
        <StartDatePicker
          startDate={issue.start_date}
          onUpdate={handleUpdate}
          tooltip={t(($) => $.detail.prop_start_date)}
          trigger={<span className="tabular-nums">{startText}</span>}
        />
      </PickerWrapper>
    ) : (
      <span className="shrink-0 tabular-nums">{startText}</span>
    )
  ) : null;

  const dueText = showDueDate
    ? isOverdue
      ? t(($) => $.card.overdue_days, { count: overdueDays })
      : formatDate(issue.due_date!, locale)
    : null;
  const dueClass = cn(
    "shrink-0 tabular-nums",
    isOverdue && "font-semibold text-priority-urgent",
  );
  const dueNode = dueText ? (
    canEdit ? (
      <PickerWrapper className="flex shrink-0">
        <DueDatePicker
          dueDate={issue.due_date}
          onUpdate={handleUpdate}
          tooltip={t(($) => $.detail.prop_due_date)}
          trigger={<span className={dueClass}>{dueText}</span>}
        />
      </PickerWrapper>
    ) : (
      <span className={dueClass}>{dueText}</span>
    )
  ) : null;

  const hasDates = !!startNode || !!dueNode;
  const updatedHint = (
    <span className="min-w-0 truncate">
      {t(($) => $.card.updated_ago, { time: timeAgo(issue.updated_at) })}
    </span>
  );

  const showMetaLine = showCustomStatus || showProject || showLabels || cardCustomProperties.length > 0;

  return (
    <div className={BOARD_CARD_SURFACE}>
      {/* Top row: identifier (left), assignee (right) */}
      <div className="flex h-4.5 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-caption text-faint-foreground">{issue.identifier}</p>
          <IssueDuplicateOfMarker issue={issue} insideLink />
        </div>
        {assigneeNode}
      </div>

      <p
        className={cn(
          "mt-1.5 line-clamp-2 text-body font-medium",
          isFinished && "text-muted-foreground",
        )}
      >
        {issue.title}
      </p>

      {showDescription && (() => {
        const preview = descriptionPreview(issue.description!);
        if (!preview) return null;
        return (
          <p className="mt-3 line-clamp-2 text-label text-muted-foreground">
            {preview}
          </p>
        );
      })()}

      {/* Meta line: custom status, project, labels and custom property values
          as plain muted text. The status chip renders only for a CUSTOM
          status — the column header already names the category. (MUL-6243) */}
      {showMetaLine && (
        <div className="mt-3 flex min-w-0 items-center gap-3 overflow-hidden text-caption text-muted-foreground">
          <CustomStatusChip status={issue.status} />
          {showProject && (
            <span className={cn(BOARD_CARD_META_ITEM, "max-w-40 shrink-0")}>
              <Folder className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{project!.title}</span>
            </span>
          )}
          {showLabels && labels.slice(0, 2).map((label) => (
            <span key={label.id} className={cn(BOARD_CARD_META_ITEM, "max-w-32")}>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: label.color }}
              />
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          {showLabels && labels.length > 2 && (
            <span className="shrink-0 tabular-nums">+{labels.length - 2}</span>
          )}
          {cardCustomProperties.map((property) => (
            <span key={property.id} className={cn(BOARD_CARD_META_ITEM, "max-w-40")}>
              <PropertyIcon property={property} className="size-3 text-micro" />
              <CustomPropertyValueDisplay property={property} value={issue.properties?.[property.id]} />
            </span>
          ))}
        </div>
      )}

      {/* Footer: priority, dates, child progress (left); agent status or last
          update (right) */}
      <div className="mt-3 flex h-4.5 items-center gap-2 text-caption text-faint-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          {priorityIconNode}
          {hasDates && (
            <span className="flex shrink-0 items-center">
              {startNode}
              {startNode && dueNode && <span aria-hidden="true">&nbsp;–&nbsp;</span>}
              {dueNode}
            </span>
          )}
          {showChildProgress && (
            <span className="inline-flex shrink-0 items-center">
              {hasDates && <span aria-hidden="true" className="whitespace-pre">{FOOTER_SEPARATOR}</span>}
              <span className="inline-flex items-center gap-1">
                <ProgressRing done={childProgress!.done} total={childProgress!.total} size={12} />
                <span className="tabular-nums">
                  {childProgress!.done}/{childProgress!.total}
                </span>
              </span>
            </span>
          )}
        </div>
        <div className="ml-auto flex min-w-0 items-center">
          <IssueAgentActivityIndicator issueId={issue.id} variant="status" fallback={updatedHint} />
        </div>
      </div>
    </div>
  );
});

const animateLayoutChanges: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args;
  if (isSorting || wasDragging) return false;
  return defaultAnimateLayoutChanges(args);
};

export const DraggableBoardCard = memo(function DraggableBoardCard({
  issue,
  childProgress,
  project,
  disableSorting,
}: {
  issue: Issue;
  childProgress?: ChildProgress;
  project?: Project;
  disableSorting?: boolean;
}) {
  const p = useWorkspacePaths();
  const peek = useIssuePeekActions();
  const peeked = useIsIssuePeeked(issue.id);
  const peekLinkProps = useIssuePeekLinkProps(issue.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    data: { status: issue.status },
    animateLayoutChanges,
    transition: DRAG_SHIFT_TRANSITION,
    disabled: disableSorting ? { droppable: true } : undefined,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <IssueActionsContextMenu issue={issue}>
      <div
        ref={setNodeRef}
        style={style}
        data-board-card=""
        {...{ [PEEK_TARGET_ATTR]: issue.id }}
        data-peeked={peeked ? "" : undefined}
        {...attributes}
        {...listeners}
        className={`group/card outline-none motion-reduce:transition-none! ${isDragging ? "opacity-30" : ""}`}
        onKeyDown={
          peek
            ? (e) => {
                // Space peeks the focused card (the card itself or its link,
                // never a picker button inside it). The board registers no
                // keyboard drag sensor, so Space is free here.
                if (e.key !== " " || e.repeat) return;
                if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName !== "A") return;
                e.preventDefault();
                peek.toggle(issue.id);
              }
            : undefined
        }
      >
        <AppLink
          href={p.issueDetail(issue.id)}
          newTabTitle={issue.identifier}
          className={`group block outline-none transition-colors ${isDragging ? "pointer-events-none" : ""}`}
          {...peekLinkProps}
        >
          <BoardCardContent
            issue={issue}
            editable
            childProgress={childProgress}
            project={project}
          />
        </AppLink>
      </div>
    </IssueActionsContextMenu>
  );
});
