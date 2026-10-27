import { KB_MANAGE_TABS, type KbManageTab } from "@marvis/core/paths";

/** Which management or graph route a pathname is. */
export interface KbManageRoute {
  view: "manage" | "graph" | null;
  kbSlug: string;
  tab: KbManageTab;
}

/** /{ws}/kb/{kb}/manage[/{tab}] and /{ws}/kb/{kb}/graph. */
export function parseKbManageRoute(pathname: string): KbManageRoute {
  const parts = pathname.split("/").filter(Boolean);
  // parts[0] is the workspace slug.
  const view = parts[3] === "manage" || parts[3] === "graph" ? parts[3] : null;
  if (parts[1] !== "kb" || !parts[2] || !view) return { view: null, kbSlug: "", tab: "raw" };

  let kbSlug = parts[2];
  try {
    kbSlug = decodeURIComponent(kbSlug);
  } catch {
    // Keep the raw segment.
  }
  const tab = (KB_MANAGE_TABS as readonly string[]).includes(parts[4] ?? "") ? (parts[4] as KbManageTab) : "raw";

  return { view, kbSlug, tab };
}
