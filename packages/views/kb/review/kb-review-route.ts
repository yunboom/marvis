import type { KbMergeRequestOrigin } from "@marvis/core/types";
import type { WorkspacePaths } from "@marvis/core/paths";

/** Which review route a pathname is: the review list or the change log, with a merge request number. */
export interface KbReviewRoute {
  view: "reviews" | "changes" | null;
  kbSlug: string;
  /** 0 when the route names no merge request. */
  number: number;
}

/** /{ws}/kb/{kb}/reviews[/{number}] and /{ws}/kb/{kb}/changes[/{number}]. */
export function parseKbReviewRoute(pathname: string): KbReviewRoute {
  const parts = pathname.split("/").filter(Boolean);
  // parts[0] is the workspace slug.
  const view = parts[3] === "reviews" || parts[3] === "changes" ? parts[3] : null;
  if (parts[1] !== "kb" || !parts[2] || !view) return { view: null, kbSlug: "", number: 0 };

  const number = Number.parseInt(parts[4] ?? "", 10);
  let kbSlug = parts[2];
  try {
    kbSlug = decodeURIComponent(kbSlug);
  } catch {
    // Keep the raw segment.
  }

  return { view, kbSlug, number: Number.isFinite(number) && number > 0 ? number : 0 };
}

/** Where a merge request's origin opens; null for none. */
export function kbOriginHref(
  p: WorkspacePaths,
  kbSlug: string,
  origin: KbMergeRequestOrigin,
  reverts: number | null,
): string | null {
  if (!origin.openable) return null;
  switch (origin.type) {
    case "kb_job":
      return origin.ref_id ? p.kbJob(kbSlug, origin.ref_id) : null;
    case "revert":
      return reverts ? p.kbMergeRequest(kbSlug, reverts) : null;
    case "autopilot_run":
      return origin.ref_id ? p.autopilotDetail(origin.ref_id) : null;
    case "issue":
      return origin.ref_id ? p.issueDetail(origin.ref_id) : null;
    case "chat":
      return origin.ref_id ? p.chatSession(origin.ref_id) : null;
    default:
      return null;
  }
}
