import { Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

export type RunStatus = "issue_created" | "running" | "skipped" | "completed" | "failed";

export const RUN_VISUAL: Record<RunStatus, { color: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  issue_created: { color: "text-blue-500", icon: Clock },
  running: { color: "text-blue-500", icon: Loader2, spin: true },
  // `skipped` (admission check found the assignee runtime offline,
  // MUL-1899) is muted so it doesn't read as a failure-ratio inflator.
  // The row still shows failure_reason which carries the skip context.
  skipped: { color: "text-muted-foreground", icon: Ban },
  completed: { color: "text-emerald-500", icon: CheckCircle2 },
  failed: { color: "text-destructive", icon: XCircle },
};

/** Narrows a server run status; an unknown future value reads as pending. */
export function runStatusOf(status: string): RunStatus {
  return status in RUN_VISUAL ? (status as RunStatus) : "issue_created";
}
