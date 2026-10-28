import type { AutopilotRun } from "@marvis/core/types";

/** Where a run history row opens: its issue, its run page, or nowhere. */
export type RunDestination = "issue" | "run" | null;

/**
 * Judges a run by what it produced rather than by the autopilot's current
 * mode, which may have changed since: a create_issue run carries its issue,
 * and only a run_only run carries a task without one. A run that produced
 * neither (failed before dispatch) left no trace of its mode, so it follows
 * the autopilot's current mode — the run page shows why it did not execute.
 */
export function runDestination(
  run: Pick<AutopilotRun, "issue_id" | "task_id">,
  autopilotRunOnly: boolean,
): RunDestination {
  if (run.issue_id) return "issue";
  if (run.task_id) return "run";

  return autopilotRunOnly ? "run" : null;
}
