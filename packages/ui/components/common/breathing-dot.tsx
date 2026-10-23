import type { ComponentProps } from "react";
import { cn } from "@marvis/ui/lib/utils";

interface BreathingDotProps extends Omit<ComponentProps<"span">, "children"> {
  /** Running: green dot that breathes with a fading halo. Idle: static grey dot. */
  active?: boolean;
}

/** 6px status dot for agent activity. Decorative; pair it with a text label. */
export function BreathingDot({ active = true, className, ...props }: BreathingDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-1.5 shrink-0", className)}
      {...props}
    >
      {active && (
        <span className="animate-breathe-halo absolute inset-0 rounded-full bg-(--agent-running)" />
      )}
      <span
        className={cn(
          "relative inline-flex size-1.5 rounded-full",
          active ? "animate-breathe bg-(--agent-running)" : "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}
