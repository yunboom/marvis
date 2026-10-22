"use client";

import { cn } from "@marvis/ui/lib/utils";

export function RadioMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-[18px] shrink-0 rounded-full transition-[border-width,border-color] duration-(--motion-fast) ease-out",
        selected ? "border-[5px] border-foreground" : "border-[1.5px] border-input",
      )}
    >
    </span>
  );
}
