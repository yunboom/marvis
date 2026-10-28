import type { KbJobDetail } from "@marvis/core/types";

export interface KbJobRoute {
  /** null when the path is not a job route. */
  view: "list" | "new" | "job" | null;
  kbSlug: string;
  jobId: string;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Reads /{ws}/kb/{slug}/jobs, …/jobs/new and …/jobs/{id}. */
export function parseKbJobRoute(pathname: string): KbJobRoute {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  // parts[0] is the workspace slug.
  if (parts[1] !== "kb" || !parts[2] || parts[3] !== "jobs") return { view: null, kbSlug: "", jobId: "" };

  const kbSlug = parts[2];
  if (!parts[4]) return { view: "list", kbSlug, jobId: "" };
  if (parts[4] === "new") return { view: "new", kbSlug, jobId: "" };

  return { view: "job", kbSlug, jobId: parts[4] };
}

/**
 * What the draft side of a job shows (designs 9.3–9.17):
 *  - nodraft: the agent has not created the draft (9.17), submit disabled
 *  - empty: a draft without changes while the agent works
 *  - nochange: a finished turn left no changes, "no change needed" (9.13)
 *  - changes: changes not submitted yet (9.4, 9.9, 9.11, 9.12), or submitted
 *    and then closed (9.14)
 *  - submitted: an open merge request, read-only (9.6, 9.10)
 *  - merged: read-only, the conversation is over (9.15)
 *  - discarded: the member discarded the draft
 */
export type KbJobDraftView = "nodraft" | "empty" | "nochange" | "changes" | "submitted" | "merged" | "discarded";

export interface KbJobPanelState {
  view: KbJobDraftView;
  /** Submit is shown (enabled or not). */
  showSubmit: boolean;
  canSubmit: boolean;
  canDiscard: boolean;
  lintErrors: number;
  hasConflicts: boolean;
  /** The latest merge request was closed; submitting opens a new one. */
  reopened: boolean;
  /** The conversation is over: the composer is read-only. */
  ended: boolean;
}

/** Derives the draft side of a job page from the job and whether a turn runs. */
export function kbJobPanelState(job: KbJobDetail, running: boolean): KbJobPanelState {
  const lintErrors = job.checks.lint.filter((finding) => finding.severity === "error").length;
  const hasConflicts = job.checks.conflicts.length > 0;
  const mr = job.merge_request;
  const base = { lintErrors, hasConflicts, reopened: false, ended: false, canDiscard: false, showSubmit: false, canSubmit: false };

  if (!job.draft_id || !job.draft) {
    return { ...base, view: "nodraft", showSubmit: true };
  }
  if (job.draft.status === "discarded") return { ...base, view: "discarded", ended: true };
  if (job.draft.status === "merged" || mr?.status === "merged") return { ...base, view: "merged", ended: true };
  if (job.draft.status === "submitted" || mr?.status === "open") return { ...base, view: "submitted" };
  if (job.pages.length === 0) return { ...base, view: running ? "empty" : "nochange" };

  return {
    ...base,
    view: "changes",
    reopened: mr?.status === "closed",
    showSubmit: true,
    canDiscard: true,
    canSubmit: !running && lintErrors === 0,
  };
}
