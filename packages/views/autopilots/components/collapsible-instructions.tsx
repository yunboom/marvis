"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { ReadonlyContent } from "../../editor";
import { useT } from "../../i18n";

// About five lines of body text. The class and the pixel threshold describe
// the same box: the threshold decides whether the toggle is worth showing.
const COLLAPSED_HEIGHT_PX = 128;
const COLLAPSED_CLASS = "max-h-32";

/**
 * The autopilot's instructions, folded to a few lines with a fade until the
 * reader asks for the rest. Short instructions render whole with no toggle.
 */
export function CollapsibleInstructions({ content }: { content: string }) {
  const { t } = useT("autopilots");
  const contentId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measures the unclamped inner box, so the answer holds whether or not the
  // outer box is currently folded. Re-measures on resize: the column width
  // changes how many lines the same text takes.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_HEIGHT_PX);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => observer.disconnect();
  }, [content]);

  const folded = overflows && !expanded;

  return (
    <div className="flex flex-col gap-1">
      <div
        id={contentId}
        className={cn(
          "overflow-hidden",
          folded && COLLAPSED_CLASS,
          folded && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
        )}
      >
        <div ref={innerRef}>
          <ReadonlyContent content={content} />
        </div>
      </div>
      {overflows && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 self-start text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t(($) => $.detail.instructions_collapse) : t(($) => $.detail.instructions_expand)}
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
      )}
    </div>
  );
}
