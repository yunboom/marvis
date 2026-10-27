// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EMPTY_INBOX_FILTERS, type InboxFilters } from "./filter-store";
import {
  filterInboxByCategory,
  inboxCategoryOf,
  inboxFiltersForCategory,
  inboxUnreadByCategory,
  parseInboxCategory,
} from "./category";

describe("inbox categories", () => {
  it("places each type, and leaves unknown types to All", () => {
    expect(inboxCategoryOf("mentioned")).toBe("issue");
    expect(inboxCategoryOf("quick_create_unconfirmed")).toBe("issue");
    expect(inboxCategoryOf("kb_mr_changes_requested")).toBe("kb");
    expect(inboxCategoryOf("kb_mr_review_needed")).toBe("kb");
    expect(inboxCategoryOf("autopilot_quota_exceeded")).toBe("autopilot");
    expect(inboxCategoryOf("something_new")).toBeNull();
    expect(inboxCategoryOf("toString")).toBeNull();
  });

  it("reads the URL parameter", () => {
    expect(parseInboxCategory("kb")).toBe("kb");
    expect(parseInboxCategory("chat")).toBeNull();
    expect(parseInboxCategory(null)).toBeNull();
  });

  it("filters items and counts unread per tab", () => {
    const items = [
      { type: "mentioned", read: false },
      { type: "kb_mr_review_requested", read: false },
      { type: "kb_mr_changes_requested", read: true },
      { type: "something_new", read: false },
    ] as const;

    expect(filterInboxByCategory([...items], "kb")).toHaveLength(2);
    expect(filterInboxByCategory([...items], null)).toHaveLength(4);
    expect(inboxUnreadByCategory([...items])).toEqual({ all: 3, issue: 1, kb: 1, autopilot: 0 });
  });

  it("ignores the issue-only filters outside All and Issues", () => {
    const filters: InboxFilters = { ...EMPTY_INBOX_FILTERS, statuses: ["done"], priorities: ["high"], idleOnly: true, unreadOnly: true, actors: ["system"] };

    expect(inboxFiltersForCategory(filters, "issue")).toBe(filters);
    expect(inboxFiltersForCategory(filters, null)).toBe(filters);
    expect(inboxFiltersForCategory(filters, "kb")).toEqual({ ...filters, statuses: [], priorities: [], idleOnly: false });
  });
});
