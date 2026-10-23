import type { IssueStatus, IssueStatusCategory } from "../types";

/**
 * The fixed columns of a status-grouped board. Each column stacks one lane
 * per visible status; which column a status lands in depends on its lifecycle
 * category, except for the built-in review/blocked keys, which get their own
 * "needs attention" column so work waiting on a person stands out.
 */
export type BoardStatusColumnKey =
  | "not_started"
  | "started"
  | "needs_attention"
  | "ended";

export const BOARD_STATUS_COLUMN_ORDER: readonly BoardStatusColumnKey[] = [
  "not_started",
  "started",
  "needs_attention",
  "ended",
];

/** Built-in started-category keys routed to the "needs attention" column. */
export const BOARD_ATTENTION_STATUSES: readonly IssueStatus[] = [
  "in_review",
  "blocked",
];

export interface BoardStatusColumn {
  key: BoardStatusColumnKey;
  /** Visible status keys in this column, in their incoming (catalog) order. */
  statuses: IssueStatus[];
}

/** The board column a status key belongs to, given its lifecycle category. */
export function boardStatusColumnOf(
  status: IssueStatus,
  category: IssueStatusCategory,
): BoardStatusColumnKey {
  if (BOARD_ATTENTION_STATUSES.includes(status)) return "needs_attention";
  if (category === "unstarted") return "not_started";
  if (category === "started") return "started";
  return "ended";
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
  categoryOf: (status: IssueStatus) => IssueStatusCategory,
): BoardStatusColumn[] {
  const byColumn = new Map<BoardStatusColumnKey, IssueStatus[]>(
    BOARD_STATUS_COLUMN_ORDER.map((key) => [key, []]),
  );
  for (const status of visibleStatuses) {
    byColumn.get(boardStatusColumnOf(status, categoryOf(status)))!.push(status);
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
