// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIssueStatusCatalog } from "../issue-statuses";
import type { IssueStatusEntry } from "../types";
import {
  groupStatusesIntoBoardColumns,
  groupStatusesIntoWorkflowZones,
  isBoardLaneCollapsed,
} from "./board-status-columns";
import { visibleStatusKeys } from "./status-category";

const catalog = buildIssueStatusCatalog([
  { key: "triage", category: "unstarted", status_group: "not_started", name: "Triage", position: 1, is_system: false },
  { key: "qa", category: "started", status_group: "working", name: "QA", position: 2, is_system: false },
  { key: "waiting_customer", category: "started", status_group: "needs_attention", name: "Waiting", position: 3, is_system: false },
  { key: "shipped", category: "done", status_group: "ended", name: "Shipped", position: 4, is_system: false },
  { key: "wont_fix", category: "closed", status_group: "ended", name: "Won't fix", position: 5, is_system: false },
] as IssueStatusEntry[]);

function columnsOf(statuses: string[]) {
  return Object.fromEntries(
    groupStatusesIntoBoardColumns(statuses, catalog.groupOf).map((column) => [
      column.key,
      column.statuses,
    ]),
  );
}

describe("groupStatusesIntoBoardColumns", () => {
  it("routes built-in statuses by their fixed group", () => {
    expect(
      columnsOf(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]),
    ).toEqual({
      not_started: ["backlog", "todo"],
      working: ["in_progress"],
      needs_attention: ["in_review", "blocked"],
      ended: ["done", "cancelled"],
    });
  });

  it("places custom statuses by their stored group, needs attention included", () => {
    const columns = columnsOf(visibleStatusKeys([], [], catalog));

    expect(columns.not_started).toContain("triage");
    expect(columns.working).toContain("qa");
    expect(columns.needs_attention).toEqual(expect.arrayContaining(["in_review", "blocked", "waiting_customer"]));
    expect(columns.ended).toEqual(expect.arrayContaining(["shipped", "wont_fix"]));
  });

  it("drops hidden statuses and keeps a column whose lanes are all hidden", () => {
    const visible = visibleStatusKeys([], ["in_review", "blocked", "waiting_customer", "cancelled"], catalog);
    const columns = groupStatusesIntoBoardColumns(visible, catalog.groupOf);

    expect(columns.map((column) => column.key)).toEqual([
      "not_started",
      "working",
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

  it("falls back to the default group when an entry carries none", () => {
    const legacy = buildIssueStatusCatalog([
      { key: "review_2", category: "started", name: "Review", position: 1, is_system: false },
    ] as IssueStatusEntry[]);

    expect(legacy.groupOf("review_2")).toBe("working");
    expect(legacy.groupOf("blocked")).toBe("needs_attention");
    expect(legacy.groupOf("unknown_key")).toBe("not_started");
  });
});

describe("groupStatusesIntoWorkflowZones", () => {
  function zonesOf(statuses: string[]) {
    return Object.fromEntries(
      groupStatusesIntoWorkflowZones(statuses).map((column) => [column.key, column.statuses]),
    );
  }

  it("lays a workflow out as start, middle, blocked, end", () => {
    const columns = groupStatusesIntoWorkflowZones([
      "backlog",
      "todo",
      "dev",
      "in_review",
      "qa",
      "blocked",
      "done",
      "cancelled",
    ]);

    expect(columns).toEqual([
      { key: "start", statuses: ["backlog", "todo"] },
      { key: "middle", statuses: ["dev", "in_review", "qa"] },
      { key: "blocked", statuses: ["blocked"] },
      { key: "end", statuses: ["done", "cancelled"] },
    ]);
  });

  it("keeps workflow order inside the middle zone, whatever the status group", () => {
    expect(zonesOf(["todo", "qa", "waiting_customer", "in_progress", "done"]).middle).toEqual([
      "qa",
      "waiting_customer",
      "in_progress",
    ]);
  });

  it("puts a status the workflow does not list in the middle zone", () => {
    expect(zonesOf(["triage", "shipped"]).middle).toEqual(["triage", "shipped"]);
  });

  it("keeps every zone when the workflow leaves out backlog and blocked", () => {
    const columns = zonesOf(["todo", "in_progress", "done", "cancelled"]);

    expect(columns.blocked).toEqual([]);
    expect(columns.start).toEqual(["todo"]);
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
