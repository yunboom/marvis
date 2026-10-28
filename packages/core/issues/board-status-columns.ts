import { STATUS_GROUP_ORDER } from "./config/status";
import {
  WORKFLOW_ZONE_ORDER,
  workflowZoneOf,
  type WorkflowZone,
} from "../issue-workflows/queries";
import type { IssueStatus, IssueStatusCategory, IssueStatusGroup } from "../types";

/**
 * The fixed columns of a status-grouped board. Boards outside a project use
 * one column per status group; a project board follows its workflow's zones
 * instead. Each column stacks one lane per visible status. The two key sets
 * do not overlap, so per-column state (scroll position) never mixes them.
 */
export type BoardStatusColumnKey = IssueStatusGroup | WorkflowZone;

export const BOARD_STATUS_COLUMN_ORDER: readonly IssueStatusGroup[] = STATUS_GROUP_ORDER;

export interface BoardStatusColumn {
  key: BoardStatusColumnKey;
  /** Visible status keys in this column, in their incoming order. */
  statuses: IssueStatus[];
}

/**
 * Distributes statuses over fixed columns. Always returns every column in
 * display order — a column whose statuses are all hidden or filtered out
 * comes back with an empty list so the surface can render its empty state
 * rather than reflowing the grid. Status order inside a column follows
 * `visibleStatuses`.
 */
function distributeStatuses<K extends BoardStatusColumnKey>(
  order: readonly K[],
  visibleStatuses: readonly IssueStatus[],
  columnOf: (status: IssueStatus) => K,
): BoardStatusColumn[] {
  const byColumn = new Map<K, IssueStatus[]>(order.map((key) => [key, []]));
  for (const status of visibleStatuses) {
    byColumn.get(columnOf(status))!.push(status);
  }

  return order.map((key) => ({ key, statuses: byColumn.get(key)! }));
}

/** Splits the board's visible statuses into one column per status group. */
export function groupStatusesIntoBoardColumns(
  visibleStatuses: readonly IssueStatus[],
  groupOf: (status: IssueStatus) => IssueStatusGroup,
): BoardStatusColumn[] {
  return distributeStatuses(BOARD_STATUS_COLUMN_ORDER, visibleStatuses, groupOf);
}

/**
 * Splits a project board's visible statuses into its workflow's zones: start,
 * middle (shown as "Work"), blocked, end. A status the workflow does not list
 * (reachable through an explicit status filter) lands in the middle zone
 * unless it has a fixed place.
 */
export function groupStatusesIntoWorkflowZones(
  visibleStatuses: readonly IssueStatus[],
): BoardStatusColumn[] {
  return distributeStatuses(WORKFLOW_ZONE_ORDER, visibleStatuses, workflowZoneOf);
}

/**
 * Whether a board lane renders collapsed (header only).
 *
 * An empty lane is always collapsed: there is nothing to show, and its header
 * still works as a drop target. Otherwise the user's saved choice wins, and
 * without one, closed-category lanes (cancelled and the like) start collapsed.
 */
export function isBoardLaneCollapsed({
  category,
  count,
  saved,
}: {
  category: IssueStatusCategory;
  count: number;
  saved: boolean | undefined;
}): boolean {
  if (count === 0) return true;
  if (saved !== undefined) return saved;

  return category === "closed";
}
