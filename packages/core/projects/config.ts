import type { ProjectStatus, ProjectPriority } from "../types";

export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  "planned",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
];

export const PROJECT_STATUS_CONFIG: Record<
  ProjectStatus,
  { label: string; color: string; dotColor: string; badgeBg: string; badgeText: string }
> = {
  planned: { label: "Planned", color: "text-muted-foreground", dotColor: "bg-muted-foreground", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
  in_progress: { label: "In Progress", color: "text-warning", dotColor: "bg-warning", badgeBg: "bg-warning", badgeText: "text-white" },
  paused: { label: "Paused", color: "text-muted-foreground", dotColor: "bg-muted-foreground", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
  completed: { label: "Completed", color: "text-info", dotColor: "bg-info", badgeBg: "bg-info", badgeText: "text-white" },
  cancelled: { label: "Cancelled", color: "text-destructive", dotColor: "bg-destructive", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
};

export const PROJECT_PRIORITY_ORDER: ProjectPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export const PROJECT_PRIORITY_CONFIG: Record<
  ProjectPriority,
  { label: string; bars: number; color: string; badgeBg: string; badgeText: string }
> = {
  urgent: { label: "Urgent", bars: 4, color: "text-priority-urgent", badgeBg: "bg-priority-urgent/10", badgeText: "text-priority-urgent" },
  high: { label: "High", bars: 3, color: "text-priority-high", badgeBg: "bg-priority-high/10", badgeText: "text-priority-high" },
  medium: { label: "Medium", bars: 2, color: "text-priority-medium", badgeBg: "bg-priority-medium/10", badgeText: "text-priority-medium" },
  low: { label: "Low", bars: 1, color: "text-priority-low", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
  none: { label: "No priority", bars: 0, color: "text-muted-foreground", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
};

// Project icons the pickers offer. The API stores `icon` as free text, so
// values outside this set (emoji set through the CLI or older clients)
// render as the default glyph.
export const PROJECT_ICONS = [
  "folder",
  "briefcase",
  "rocket",
  "target",
  "flag",
  "compass",
  "layers",
  "box",
  "code",
  "terminal",
  "git-branch",
  "database",
  "server",
  "cloud",
  "smartphone",
  "monitor",
  "palette",
  "pen-tool",
  "book-open",
  "file-text",
  "megaphone",
  "chart-line",
  "lightbulb",
  "sparkles",
  "users",
  "shield",
  "bug",
  "wrench",
  "calendar",
  "mountain",
  "leaf",
  "feather",
] as const;

export type ProjectIconKey = (typeof PROJECT_ICONS)[number];

export const DEFAULT_PROJECT_ICON: ProjectIconKey = "folder";

const PROJECT_ICON_SET = new Set<string>(PROJECT_ICONS);

/** Returns the icon key, or null for empty and legacy free-text values. */
export function parseProjectIcon(icon: string | null | undefined): ProjectIconKey | null {
  return icon && PROJECT_ICON_SET.has(icon) ? (icon as ProjectIconKey) : null;
}
