import type { InboxItemType } from "../types";
import type { InboxFilters } from "./filter-store";

/**
 * Inbox categories (decision 108): the tabs above the inbox list. "All" is no
 * category: it lists every notification, including types no category claims.
 */
export type InboxCategory = "issue" | "kb" | "autopilot";

/** The tabs in order; null is "All". */
export const INBOX_CATEGORY_TABS: readonly (InboxCategory | null)[] = [null, "issue", "kb", "autopilot"];

/**
 * The category of every notification type. Mirrors categoryTypes in
 * server/internal/inbox/category.go, which narrows the archive and
 * mark-all-read the same way. A new type must be placed here.
 */
export const INBOX_CATEGORY_OF: Record<InboxItemType, InboxCategory> = {
  issue_assigned: "issue",
  issue_subscribed: "issue",
  unassigned: "issue",
  assignee_changed: "issue",
  status_changed: "issue",
  priority_changed: "issue",
  start_date_changed: "issue",
  due_date_changed: "issue",
  new_comment: "issue",
  mentioned: "issue",
  review_requested: "issue",
  task_completed: "issue",
  task_failed: "issue",
  agent_blocked: "issue",
  agent_completed: "issue",
  reaction_added: "issue",
  children_done: "issue",
  quick_create_done: "issue",
  quick_create_failed: "issue",
  quick_create_unconfirmed: "issue",
  kb_mr_changes_requested: "kb",
  kb_mr_review_requested: "kb",
  kb_mr_review_needed: "kb",
  autopilot_paused: "autopilot",
  autopilot_quota_exceeded: "autopilot",
};

/** A type's category; null for a type this client does not know (only under "All"). */
export function inboxCategoryOf(type: string): InboxCategory | null {
  return Object.hasOwn(INBOX_CATEGORY_OF, type) ? INBOX_CATEGORY_OF[type as InboxItemType] : null;
}

/** Reads a `?category=` value; anything else is "All". */
export function parseInboxCategory(raw: string | null | undefined): InboxCategory | null {
  return raw === "issue" || raw === "kb" || raw === "autopilot" ? raw : null;
}

/** Keeps the items of a category; "All" (null) keeps every item. */
export function filterInboxByCategory<T extends { type: string }>(items: T[], category: InboxCategory | null): T[] {
  if (!category) return items;

  return items.filter((item) => inboxCategoryOf(item.type) === category);
}

/** Whether a category has issue notifications, so the issue-only filters apply. */
export function inboxCategoryHasIssues(category: InboxCategory | null): boolean {
  return category === null || category === "issue";
}

/**
 * The filters that apply in a category: knowledge base and autopilot
 * notifications have no issue, so status, priority and "no agent working"
 * are ignored there (and kept for when the member switches back).
 */
export function inboxFiltersForCategory<F extends Pick<InboxFilters, "statuses" | "priorities"> & Partial<Pick<InboxFilters, "idleOnly">>>(
  filters: F,
  category: InboxCategory | null,
): F {
  if (inboxCategoryHasIssues(category)) return filters;
  if (filters.statuses.length === 0 && filters.priorities.length === 0 && !filters.idleOnly) return filters;

  return { ...filters, statuses: [], priorities: [], ...("idleOnly" in filters ? { idleOnly: false } : {}) };
}

/** Unread rows per tab: "all" and each category. */
export type InboxCategoryCounts = Record<"all" | InboxCategory, number>;

export function inboxUnreadByCategory(items: { type: string; read: boolean }[]): InboxCategoryCounts {
  const counts: InboxCategoryCounts = { all: 0, issue: 0, kb: 0, autopilot: 0 };
  for (const item of items) {
    if (item.read) continue;
    counts.all++;
    const category = inboxCategoryOf(item.type);
    if (category) counts[category]++;
  }

  return counts;
}
