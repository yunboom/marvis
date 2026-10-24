import type { Autopilot } from "@marvis/core/types";
import { useT } from "../../i18n";

/** system_key of the built-in daily knowledge digest. */
export const KNOWLEDGE_DIGEST_KEY = "knowledge-digest";

/** pause_reason set when the last knowledge base is deleted. */
export const PAUSE_REASON_NO_KNOWLEDGE_BASE = "no_knowledge_base";

/** Built-in autopilots can be paused and edited but never deleted. */
export function isSystemAutopilot(autopilot: Pick<Autopilot, "system_key">): boolean {
  return Boolean(autopilot.system_key);
}

/**
 * Display title: built-in autopilots are named by their system key in the
 * viewer's language; the stored title is the server's English default.
 */
export function useAutopilotTitle(): (autopilot: Pick<Autopilot, "title" | "system_key">) => string {
  const { t } = useT("autopilots");

  return (autopilot) => (autopilot.system_key === KNOWLEDGE_DIGEST_KEY ? t(($) => $.system.knowledge_digest) : autopilot.title);
}
