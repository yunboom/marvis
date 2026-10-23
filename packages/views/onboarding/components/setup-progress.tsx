"use client";

import { Fragment } from "react";
import { Check } from "lucide-react";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";

type SetupStep = "workspace" | "runtime";

const STEPS: SetupStep[] = ["workspace", "runtime"];

/**
 * The two steps of setting up a workspace — create it, then connect a
 * runtime — shown at the top of both pages: done steps carry a check, the
 * current one a filled dot, later ones an empty ring.
 */
export function SetupProgress({ current }: { current: SetupStep }) {
  const { t } = useT("onboarding");
  const currentIndex = STEPS.indexOf(current);
  const label = (step: SetupStep) =>
    step === "workspace"
      ? t(($) => $.step_connect.progress_workspace)
      : t(($) => $.step_connect.progress_runtime);

  return (
    <ol className="flex items-center gap-2.5 text-label">
      {STEPS.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <Fragment key={step}>
            {index > 0 ? <li aria-hidden className="h-px w-5 shrink-0 bg-input" /> : null}
            <li
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap",
                active ? "font-medium" : "text-muted-foreground",
              )}
            >
              {done ? (
                <span
                  aria-hidden
                  className="flex size-4 items-center justify-center rounded-full bg-foreground text-background"
                >
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border-[1.5px]",
                    active ? "border-foreground" : "border-input",
                  )}
                >
                  {active ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
                </span>
              )}
              {label(step)}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
