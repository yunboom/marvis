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
import { formatDateOnly, isPastDateOnly } from "@marvis/core/issues/date";
import { CalendarClock, CalendarDays } from "lucide-react";
import { ActorAvatar } from "../../common/actor-avatar";
import { PropertyIcon } from "../../common/property-icon";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import { useLocale, useT, useTimeAgo } from "../../i18n";
import { ProjectIcon } from "../../projects/components/project-icon";
import { PriorityIcon } from "./priority-icon";
import { PriorityPicker, AssigneePicker, StartDatePicker, DueDatePicker } from "./pickers";
import { useViewStore } from "@marvis/core/issues/stores/view-store-context";
import { propertyIdFromViewKey } from "@marvis/core/issues/stores/view-store";
import { ProgressRing } from "./progress-ring";
import type { ChildProgress } from "./list-row";
import { IssueActionsContextMenu } from "../actions";
import { LabelChip } from "../../labels/label-chip";
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

// 看板卡片：白卡 + 细描边，悬停只加深描边（进 100ms、出 150ms）
const BOARD_CARD_SURFACE =
  "rounded-lg border border-border bg-card p-3 shadow-control transition-colors duration-(--motion-fast) ease-out dark:shadow-none group-hover/card:border-input group-hover/card:duration-(--motion-instant) group-data-[popup-open]/card:border-input group-data-[peeked]/card:ring-2 group-data-[peeked]/card:ring-brand/50";

// 卡片里的项目 / 自定义属性小标签：20px 药丸、浅灰底
const BOARD_CARD_CHIP =
  "inline-flex h-5 items-center gap-1 rounded-full bg-field pr-1.5 pl-1 text-micro text-muted-foreground";

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
        "cursor-grabbing rounded-lg transition-[scale,rotate,box-shadow] duration-(--motion-fast) ease-out motion-reduce:transition-none data-[lifted]:scale-[1.02] data-[lifted]:rotate-[1.5deg] data-[lifted]:shadow-menu",
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

  const showAssigneeName = showAssigneeSection && hasAssignee && !showStartDate && !showDueDate;
  const showUpdatedHint = showAssigneeName && !showChildProgress;
  const { getActorName } = useActorName();
  const assigneeName =
    showAssigneeName && issue.assignee_type && issue.assignee_id
      ? getActorName(issue.assignee_type, issue.assignee_id)
      : null;

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
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs transition-colors duration-(--motion-fast) hover:bg-accent"
            >
              <PriorityIcon priority={issue.priority} />
            </button>
          }
        />
      </PickerWrapper>
    ) : (
      <span
        aria-label={priorityLabel}
        className="inline-flex size-5 shrink-0 items-center justify-center"
      >
        <PriorityIcon priority={issue.priority} />
      </span>
    )
  ) : null;

  // The parent row gives this container the leftover space; min-w-0 and
  // max-w-full make the nested picker trigger respect that limit.
  const assigneeContainerClass = assigneeName
    ? "flex min-w-0 max-w-full items-center"
    : "inline-flex items-center";

  const assigneeInner = hasAssignee ? (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      <ActorAvatar
        actorType={issue.assignee_type!}
        actorId={issue.assignee_id!}
        size="sm"
        enableHoverCard
        profileLink={false}
        className="shrink-0"
      />
      {assigneeName && (
        <span className="min-w-0 truncate text-caption text-foreground">{assigneeName}</span>
      )}
    </span>
  ) : (
    <span className="text-caption text-muted-foreground">{t(($) => $.pickers.assignee.trigger_unassigned)}</span>
  );

  const assigneeNode = showAssigneeSection ? (
    canEdit ? (
      <PickerWrapper className={assigneeContainerClass}>
        <AssigneePicker
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          onUpdate={handleUpdate}
          trigger={assigneeInner}
        />
      </PickerWrapper>
    ) : (
      <span className={assigneeContainerClass}>{assigneeInner}</span>
    )
  ) : null;

  const showMetaRow = showAssigneeSection || showStartDate || showDueDate || showChildProgress;
  const showRightMeta = !!showStartDate || !!showDueDate || !!showChildProgress || showUpdatedHint;

  return (
    <div className={BOARD_CARD_SURFACE}>
      {/* Row 1: priority + identifier (left), agent activity + assignee (right) */}
      <div className="flex min-h-5 items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {priorityIconNode}
          <p className="text-caption text-muted-foreground truncate">{issue.identifier}</p>
          <IssueDuplicateOfMarker issue={issue} insideLink />
        </div>
        <IssueAgentActivityIndicator issueId={issue.id} />
      </div>

      {/* Row 2: Title */}
      <p className="mt-1 text-body font-medium line-clamp-2">
        {issue.title}
      </p>

      {showDescription && (() => {
        const preview = descriptionPreview(issue.description!);
        if (!preview) return null;
        return (
          <p className="mt-1 text-caption text-muted-foreground line-clamp-1">
            {preview}
          </p>
        );
      })()}

      {/* Chip row: status + project + labels + custom property values.
          The status chip renders only for a CUSTOM status — the column header
          already names the category. (MUL-6243) */}
      {(showCustomStatus || showProject || showLabels || cardCustomProperties.length > 0) && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <CustomStatusChip status={issue.status} />
          {showProject && (
            <span className={`${BOARD_CARD_CHIP} max-w-40`}>
              <ProjectIcon project={project} size="sm" />
              <span className="truncate">{project!.title}</span>
            </span>
          )}
          {showLabels && labels.slice(0, 2).map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {showLabels && labels.length > 2 && (
            <span className="text-micro text-muted-foreground">
              +{labels.length - 2}
            </span>
          )}
          {cardCustomProperties.map((property) => (
            <span
              key={property.id}
              className={`${BOARD_CARD_CHIP} max-w-40`}
            >
              <PropertyIcon property={property} className="size-3 text-micro" />
              <CustomPropertyValueDisplay property={property} value={issue.properties?.[property.id]} />
            </span>
          ))}
        </div>
      )}

      {/* Meta row: assignee (left), start date, due date, child progress (right) */}
      {showMetaRow && (
        <div className="mt-2.5 flex min-h-5 items-center justify-between gap-2">
          {showAssigneeSection && (
            <div className="min-w-0 flex-1">
              {assigneeNode}
            </div>
          )}
          {showRightMeta && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {showStartDate && (
                canEdit ? (
                  <PickerWrapper className="flex shrink-0">
                    <StartDatePicker
                      startDate={issue.start_date}
                      onUpdate={handleUpdate}
                      tooltip={t(($) => $.detail.prop_start_date)}
                      trigger={
                        <span className="flex items-center gap-1 text-caption text-muted-foreground">
                          <CalendarClock className="size-3" />
                          {formatDate(issue.start_date!, locale)}
                        </span>
                      }
                    />
                  </PickerWrapper>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
                    <CalendarClock className="size-3" />
                    {formatDate(issue.start_date!, locale)}
                  </span>
                )
              )}
              {showDueDate && (
                canEdit ? (
                  <PickerWrapper className="flex shrink-0">
                    <DueDatePicker
                      dueDate={issue.due_date}
                      onUpdate={handleUpdate}
                      tooltip={t(($) => $.detail.prop_due_date)}
                      trigger={
                        <span
                          className={`flex items-center gap-1 text-caption ${
                            isPastDateOnly(issue.due_date)
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          <CalendarDays className="size-3" />
                          {formatDate(issue.due_date!, locale)}
                        </span>
                      }
                    />
                  </PickerWrapper>
                ) : (
                  <span
                    className={`flex shrink-0 items-center gap-1 text-caption ${
                      isPastDateOnly(issue.due_date)
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    <CalendarDays className="size-3" />
                    {formatDate(issue.due_date!, locale)}
                  </span>
                )
              )}
              {showChildProgress && (
                <div className="inline-flex shrink-0 items-center gap-1">
                  <ProgressRing done={childProgress!.done} total={childProgress!.total} size={14} />
                  <span className="text-micro text-muted-foreground tabular-nums font-medium">
                    {childProgress!.done}/{childProgress!.total}
                  </span>
                </div>
              )}
              {showUpdatedHint && (
                <span className="shrink-0 text-caption text-muted-foreground">
                  {t(($) => $.card.updated_ago, { time: timeAgo(issue.updated_at) })}
                </span>
              )}
            </div>
          )}
        </div>
      )}
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
        className={`group/card motion-reduce:transition-none! ${isDragging ? "opacity-30" : ""}`}
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
          className={`group block transition-colors ${isDragging ? "pointer-events-none" : ""}`}
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
