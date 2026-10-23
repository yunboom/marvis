// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIssueStatusCatalog } from "../issue-statuses";
import type { IssueStatusEntry } from "../types";
import {
  groupStatusesIntoBoardColumns,
  isBoardLaneCollapsed,
} from "./board-status-columns";
import { visibleStatusKeys } from "./status-category";

const catalog = buildIssueStatusCatalog([
  { key: "triage", category: "unstarted", name: "Triage", position: 1, is_system: false },
  { key: "qa", category: "started", name: "QA", position: 2, is_system: false },
  { key: "shipped", category: "done", name: "Shipped", position: 3, is_system: false },
  { key: "wont_fix", category: "closed", name: "Won't fix", position: 4, is_system: false },
] as IssueStatusEntry[]);

function columnsOf(statuses: string[]) {
  return Object.fromEntries(
    groupStatusesIntoBoardColumns(statuses, catalog.categoryOf).map((column) => [
      column.key,
      column.statuses,
    ]),
  );
}

describe("groupStatusesIntoBoardColumns", () => {
  it("routes built-in statuses by category, with review and blocked needing attention", () => {
    expect(
      columnsOf(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]),
    ).toEqual({
      not_started: ["backlog", "todo"],
      started: ["in_progress"],
      needs_attention: ["in_review", "blocked"],
      ended: ["done", "cancelled"],
    });
  });

  it("places custom statuses by their category, never in needs attention", () => {
    const columns = columnsOf(visibleStatusKeys([], [], catalog));

    expect(columns.not_started).toContain("triage");
    expect(columns.started).toContain("qa");
    expect(columns.needs_attention).toEqual(["in_review", "blocked"]);
    expect(columns.ended).toEqual(expect.arrayContaining(["shipped", "wont_fix"]));
  });

  it("drops hidden statuses and keeps a column whose lanes are all hidden", () => {
    const visible = visibleStatusKeys([], ["in_review", "blocked", "cancelled"], catalog);
    const columns = groupStatusesIntoBoardColumns(visible, catalog.categoryOf);

    expect(columns.map((column) => column.key)).toEqual([
      "not_started",
      "started",
      "needs_attention",
      "ended",
    ]);
    expect(columns[2]!.statuses).toEqual([]);
    expect(columns[3]!.statuses).not.toContain("cancelled");
  });

  it("keeps the incoming order inside a column", () => {
    expect(columnsOf(["todo", "triage", "backlog"]).not_started).toEqual([
      "todo",
      "triage",
      "backlog",
    ]);
  });
});

describe("isBoardLaneCollapsed", () => {
  it("collapses empty lanes regardless of the saved choice", () => {
    expect(isBoardLaneCollapsed({ category: "started", count: 0, saved: false })).toBe(true);
  });

  it("starts closed lanes collapsed and others expanded", () => {
    expect(isBoardLaneCollapsed({ category: "closed", count: 3, saved: undefined })).toBe(true);
    expect(isBoardLaneCollapsed({ category: "done", count: 3, saved: undefined })).toBe(false);
  });

  it("honours the saved choice for non-empty lanes", () => {
    expect(isBoardLaneCollapsed({ category: "closed", count: 3, saved: false })).toBe(false);
    expect(isBoardLaneCollapsed({ category: "started", count: 3, saved: true })).toBe(true);
  });
});
