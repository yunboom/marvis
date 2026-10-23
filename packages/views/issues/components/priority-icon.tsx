import type { IssuePriority } from "@marvis/core/types";
import { PRIORITY_CONFIG } from "@marvis/core/issues/config";

// Dot geometry in the 16-unit viewBox: a 10-unit dot reads as ~9px inside the
// 14px icon box, so call sites keep their layout.
const DOT_R = 5;
// The ring keeps the dot's outer edge; its stroke stays 1.5px at any size.
const RING_STROKE_PX = 1.5;
const RING_R = DOT_R - 0.85;

/**
 * Priority glyphs are small dots coloured on a warm severity ramp:
 * - urgent / high / medium: a filled dot, the colour carries the severity;
 * - low: a hollow ring, present but quiet;
 * - none: a short dash.
 */
export function PriorityIcon({
  priority,
  className = "",
  inheritColor = false,
}: {
  priority: IssuePriority | string;
  className?: string;
  inheritColor?: boolean;
}) {
  const cfg = priority in PRIORITY_CONFIG ? PRIORITY_CONFIG[priority as IssuePriority] : null;

  // "none" — simple horizontal dash
  if (!cfg || priority === "none") {
    return (
      <svg
        viewBox="0 0 16 16"
        className={`h-3.5 w-3.5 ${inheritColor ? "" : "text-muted-foreground"} shrink-0 ${className}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <line x1="3" y1="8" x2="13" y2="8" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 ${inheritColor ? "" : cfg.color} shrink-0 ${className}`}
      fill="none"
    >
      {priority === "low" ? (
        <circle
          cx="8"
          cy="8"
          r={RING_R}
          stroke="currentColor"
          strokeWidth={RING_STROKE_PX}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <circle cx="8" cy="8" r={DOT_R} fill="currentColor" />
      )}
    </svg>
  );
}
