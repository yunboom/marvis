import type * as React from "react";
import { Card } from "@marvis/ui/components/ui/card";
import { cn } from "@marvis/ui/lib/utils";

/**
 * Two-pane card for full-window setup steps (create workspace, connect a
 * runtime, connect to a server): context and actions on the left, the choice
 * on a pane to the right.
 *
 * It follows the window instead of scaling: up to 960 wide, the left column
 * flexes between 320 and 380, and the height tracks the viewport between 480
 * and 600 so the actions stay in view — the pane scrolls on its own. Short
 * windows tighten the spacing. Below `md` the three children stack intro →
 * pane → actions, so the primary button comes last.
 *
 * The page around it should center it with `py-8` and, on desktop, a
 * `<DragStrip />` above; the height budget assumes both.
 */
export function SplitCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Card
      className={cn(
        "w-full max-w-[960px] gap-0 overflow-hidden rounded-[28px] border-0 p-0 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border dark:shadow-none",
        "md:grid md:h-[clamp(480px,calc(100svh-7rem),600px)] md:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] md:grid-rows-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

/** Left column, top: progress or logo, title, subtitle, summary. */
export function SplitCardIntro({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col px-10 pt-10 md:col-start-1 md:row-start-1 [@media(max-height:760px)]:pt-8",
        className,
      )}
      {...props}
    />
  );
}

/** Right column, full height: holds the step's sunken pane. */
export function SplitCardPane({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col px-6 pt-8 md:col-start-2 md:row-span-2 md:row-start-1 md:py-8 md:pr-8 md:pl-2 [@media(max-height:760px)]:md:py-6",
        className,
      )}
      {...props}
    />
  );
}

/** Left column, bottom: the step's buttons, always in view. */
export function SplitCardActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col px-10 pt-8 pb-9 md:col-start-1 md:row-start-2 [@media(max-height:760px)]:pt-5 [@media(max-height:760px)]:pb-7",
        className,
      )}
      {...props}
    />
  );
}
