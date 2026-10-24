import type { IssuePriority } from "@marvis/core/types";
import { PRIORITY_CONFIG } from "@marvis/core/issues/config";

// Dot geometry in the 16-unit viewBox: a 10-unit dot reads as ~9px inside the
// 14px icon box, so call sites keep their layout.
const DOT_R = 5;
// The ring keeps the dot's outer edge; its stroke stays 1.5px at any size.
const RING_STROKE_PX = 1.5;
const RING_R = DOT_R - 0.85;
// The "none" slash runs corner to corner of the ring's inner square.
const SLASH_HALF = RING_R * Math.SQRT1_2;

/**
 * Priority glyphs are small dots coloured on a warm severity ramp:
 * - urgent / high / medium: a filled dot, the colour carries the severity;
 * - low: a hollow ring, present but quiet;
 * - none: the ring with a diagonal slash.
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

  // "none" — the low ring, same colour, struck through.
  if (!cfg || priority === "none") {
    return (
      <svg
        data-slot="priority-icon"
        viewBox="0 0 16 16"
        className={`h-3.5 w-3.5 ${inheritColor ? "" : PRIORITY_CONFIG.low.color} shrink-0 ${className}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE_PX}
        strokeLinecap="round"
      >
        <circle cx="8" cy="8" r={RING_R} vectorEffect="non-scaling-stroke" />
        <line
          x1={8 - SLASH_HALF}
          y1={8 + SLASH_HALF}
          x2={8 + SLASH_HALF}
          y2={8 - SLASH_HALF}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  return (
    <svg
      data-slot="priority-icon"
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
