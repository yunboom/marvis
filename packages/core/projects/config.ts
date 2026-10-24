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

// Project icons are either an emoji or a line glyph from this curated set,
// stored in the same `icon` field as `icon:<name>` so the API and older
// clients keep treating the value as an opaque string.
export const PROJECT_GLYPH_PREFIX = "icon:";

export const PROJECT_GLYPHS = [
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
  "git_branch",
  "database",
  "server",
  "cloud",
  "smartphone",
  "monitor",
  "palette",
  "pen_tool",
  "book_open",
  "file_text",
  "megaphone",
  "chart_line",
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

export type ProjectGlyph = (typeof PROJECT_GLYPHS)[number];

export type ProjectIconValue =
  | { kind: "glyph"; glyph: ProjectGlyph }
  | { kind: "emoji"; emoji: string };

const GLYPH_SET = new Set<string>(PROJECT_GLYPHS);

export function projectGlyphIcon(glyph: ProjectGlyph): string {
  return `${PROJECT_GLYPH_PREFIX}${glyph}`;
}

/** Empty values and unknown glyph keys resolve to null; callers render the default glyph. */
export function parseProjectIcon(icon: string | null | undefined): ProjectIconValue | null {
  const value = icon?.trim();
  if (!value) return null;

  if (value.startsWith(PROJECT_GLYPH_PREFIX)) {
    const glyph = value.slice(PROJECT_GLYPH_PREFIX.length);
    return GLYPH_SET.has(glyph) ? { kind: "glyph", glyph: glyph as ProjectGlyph } : null;
  }

  return { kind: "emoji", emoji: value };
}
