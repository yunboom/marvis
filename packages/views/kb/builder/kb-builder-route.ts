import type { KbBuilderMode } from "@marvis/core/types";

export interface KbBuilderRoute {
  /** null when the path is not a builder route. */
  mode: KbBuilderMode | null;
  /** The configured knowledge base; empty when creating. */
  kbSlug: string;
  /** The open conversation; empty on the runtime choice step. */
  sessionId: string;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reads /{ws}/kb/new[/{session}] (create) and /{ws}/kb/{slug}/config[/{session}]
 * (configure).
 */
export function parseKbBuilderRoute(pathname: string): KbBuilderRoute {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  // parts[0] is the workspace slug.
  if (parts[1] !== "kb") return { mode: null, kbSlug: "", sessionId: "" };

  if (parts[2] === "new") return { mode: "create", kbSlug: "", sessionId: parts[3] ?? "" };
  if (parts[2] && parts[3] === "config") {
    return { mode: "config", kbSlug: parts[2], sessionId: parts[4] ?? "" };
  }

  return { mode: null, kbSlug: "", sessionId: "" };
}
