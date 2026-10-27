import { Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

export type RunStatus = "issue_created" | "running" | "skipped" | "completed" | "failed";

/**
 * Icon and semantic color per run status: `color` tints the icon, `dot` fills
 * the list page's last-run dot, so both read the same status the same way.
 */
export const RUN_VISUAL: Record<
  RunStatus,
  { color: string; dot: string; icon: typeof CheckCircle2; spin?: boolean }
> = {
  issue_created: { color: "text-success", dot: "bg-success", icon: Clock },
  running: { color: "text-info", dot: "bg-info", icon: Loader2, spin: true },
  // `skipped` (admission check found the assignee runtime offline, MUL-1899)
  // reads as a warning, not a failure; the row still shows failure_reason,
  // which carries the skip context.
  skipped: { color: "text-warning", dot: "bg-warning", icon: Ban },
  completed: { color: "text-success", dot: "bg-success", icon: CheckCircle2 },
  failed: { color: "text-destructive", dot: "bg-destructive", icon: XCircle },
};

/** Narrows a server run status; an unknown future value reads as pending. */
export function runStatusOf(status: string): RunStatus {
  return status in RUN_VISUAL ? (status as RunStatus) : "issue_created";
}