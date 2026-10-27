// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runDestination } from "./run-destination";

describe("runDestination", () => {
  it.each([
    { name: "a run with an issue opens it", issue_id: "iss-1", task_id: "task-1", runOnly: true, want: "issue" },
    { name: "a run_only run opens its run page", issue_id: null, task_id: "task-1", runOnly: true, want: "run" },
    // The autopilot switched modes after these runs.
    { name: "a run_only run keeps its run page under create_issue", issue_id: null, task_id: "task-1", runOnly: false, want: "run" },
    { name: "a create_issue run keeps its issue under run_only", issue_id: "iss-1", task_id: "task-1", runOnly: true, want: "issue" },
    { name: "a run_only run that never dispatched opens its run page", issue_id: null, task_id: null, runOnly: true, want: "run" },
    { name: "a create_issue run that never dispatched opens nothing", issue_id: null, task_id: null, runOnly: false, want: null },
  ] as const)("$name", ({ issue_id, task_id, runOnly, want }) => {
    expect(runDestination({ issue_id, task_id }, runOnly)).toBe(want);
  });
});
