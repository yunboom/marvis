import type { ComponentProps } from "react";
import { cn } from "@marvis/ui/lib/utils";

/** Counts above this render as "99+". */
const COUNT_BADGE_MAX = 99;

interface CountBadgeProps extends Omit<ComponentProps<"span">, "children"> {
  count: number;
}

/**
 * 16px red pill with a number, for work that needs attention. The number is
 * decorative: name what it counts on the surrounding control.
 */
export function CountBadge({ count, className, ...props }: CountBadgeProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-micro leading-none font-normal tabular-nums text-white",
        className,
      )}
      {...props}
    >
      {count > COUNT_BADGE_MAX ? `${COUNT_BADGE_MAX}+` : count}
    </span>
  );
}
