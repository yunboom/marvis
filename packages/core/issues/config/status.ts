import type { BuiltInIssueStatus, IssueStatusCategory, IssueStatusGroup } from "../../types";

// These three are keyed on CATEGORY, not on status key. A workspace can define
// any number of custom statuses, but every one belongs to exactly one of the
// four lifecycle categories below. Concrete built-in status keys remain a
// separate seven-value compatibility surface. (MUL-6243, MUL-7240)

export const STATUS_ORDER: IssueStatusCategory[] = [
  "unstarted",
  "started",
  "done",
  "closed",
];

export const ALL_STATUSES: IssueStatusCategory[] = [...STATUS_ORDER];

/** API boundary: accept the installed seven-value and interim five-value enums. */
export function normalizeIssueStatusCategory(value: string): IssueStatusCategory | null {
  if (value === "completed") return "done";
  if (value === "canceled") return "closed";
  if (STATUS_ORDER.includes(value as IssueStatusCategory)) return value as IssueStatusCategory;
  return Object.hasOwn(BUILT_IN_STATUS_CATEGORY, value) ? BUILT_IN_STATUS_CATEGORY[value as BuiltInIssueStatus] : null;
}

/** The four status groups, in board and status-library order. */
export const STATUS_GROUP_ORDER: IssueStatusGroup[] = [
  "not_started",
  "working",
  "needs_attention",
  "ended",
];

/** The groups a status of `category` may sit in; mirrors the server's CHECK. */
export function statusGroupsForCategory(category: IssueStatusCategory): IssueStatusGroup[] {
  switch (category) {
    case "unstarted":
      return ["not_started"];
    case "started":
      return ["working", "needs_attention"];
    case "done":
    case "closed":
      return ["ended"];
    // A category this build does not know offers no group of its own.
    default:
      return [];
  }
}

/** The lifecycle categories a status in `group` may have. */
export function statusCategoriesForGroup(group: IssueStatusGroup): IssueStatusCategory[] {
  switch (group) {
    case "not_started":
      return ["unstarted"];
    case "working":
    case "needs_attention":
      return ["started"];
    case "ended":
      return ["done", "closed"];
  }
}

/**
 * The group a status gets when nothing chose one: in_review and blocked wait on
 * a person, every other status takes its category's first group. Matches the
 * server's default, so a response without `status_group` still groups right.
 */
export function defaultStatusGroup(key: string, category: IssueStatusCategory): IssueStatusGroup {
  if (category === "started" && (key === "in_review" || key === "blocked")) return "needs_attention";
  return statusGroupsForCategory(category)[0] ?? "not_started";
}

/** API boundary: a known group, or null for anything this build does not know. */
export function normalizeIssueStatusGroup(value: unknown): IssueStatusGroup | null {
  return typeof value === "string" && STATUS_GROUP_ORDER.includes(value as IssueStatusGroup)
    ? (value as IssueStatusGroup)
    : null;
}

export const BUILT_IN_STATUS_ORDER: BuiltInIssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

export const BUILT_IN_STATUS_CATEGORY: Record<BuiltInIssueStatus, IssueStatusCategory> = {
  backlog: "unstarted",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

export const BUILT_IN_STATUS_LABEL: Record<BuiltInIssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * Category fallbacks for statuses without their own colour. Built-in statuses
 * take their pigment from StatusIcon; these mirror the representative
 * built-in of each category (todo, in progress, done, cancelled).
 */
export const STATUS_CONFIG: Record<
  IssueStatusCategory,
  {
    label: string;
    iconColor: string;
    hoverBg: string;
    dividerColor: string;
    columnBg: string;
  }
> = {
  unstarted: { label: "Unstarted", iconColor: "text-status-todo", hoverBg: "hover:bg-accent", dividerColor: "bg-muted-foreground/40", columnBg: "bg-muted/40" },
  started: { label: "Started", iconColor: "text-status-progress", hoverBg: "hover:bg-status-progress/10", dividerColor: "bg-status-progress", columnBg: "bg-muted/40" },
  done: { label: "Done", iconColor: "text-status-done", hoverBg: "hover:bg-status-done/10", dividerColor: "bg-status-done", columnBg: "bg-muted/40" },
  closed: { label: "Closed", iconColor: "text-status-idle", hoverBg: "hover:bg-accent", dividerColor: "bg-muted-foreground/40", columnBg: "bg-muted/40" },
};
