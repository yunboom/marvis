import { STATUS_GROUP_ORDER } from "./config/status";
import type { IssueStatus, IssueStatusCategory, IssueStatusGroup } from "../types";

/**
 * The fixed columns of a status-grouped board, one per status group. Each
 * column stacks one lane per visible status; the status library edits which
 * group a status sits in.
 */
export type BoardStatusColumnKey = IssueStatusGroup;

export const BOARD_STATUS_COLUMN_ORDER: readonly BoardStatusColumnKey[] = STATUS_GROUP_ORDER;

export interface BoardStatusColumn {
  key: BoardStatusColumnKey;
  /** Visible status keys in this column, in their incoming (catalog) order. */
  statuses: IssueStatus[];
}

/**
 * Distributes the board's visible statuses over the four fixed columns.
 *
 * Always returns all four columns in display order — a column whose statuses
 * are all hidden or filtered out comes back with an empty list so the surface
 * can render its empty state rather than reflowing the grid. Status order
 * inside a column follows `visibleStatuses`, which is already catalog-ordered.
 */
export function groupStatusesIntoBoardColumns(
  visibleStatuses: readonly IssueStatus[],
  groupOf: (status: IssueStatus) => IssueStatusGroup,
): BoardStatusColumn[] {
  const byColumn = new Map<BoardStatusColumnKey, IssueStatus[]>(
    BOARD_STATUS_COLUMN_ORDER.map((key) => [key, []]),
  );
  for (const status of visibleStatuses) {
    byColumn.get(groupOf(status))!.push(status);
  }

  return BOARD_STATUS_COLUMN_ORDER.map((key) => ({
    key,
    statuses: byColumn.get(key)!,
  }));
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
