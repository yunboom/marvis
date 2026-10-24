"use client";

import { useState } from "react";
import { parseProjectIcon, PROJECT_ICONS } from "@marvis/core/projects/config";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { Popover, PopoverContent, PopoverTrigger } from "@marvis/ui/components/ui/popover";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { PROJECT_ICON_COMPONENTS, ProjectIcon } from "./project-icon";

export interface ProjectIconPickerProps {
  icon: string | null | undefined;
  /** Tooltip and accessible name of the trigger. */
  label: string;
  onChange: (icon: string) => void;
}

export function ProjectIconPicker({ icon, label, onChange }: ProjectIconPickerProps) {
  const { t } = useT("projects");
  const [open, setOpen] = useState(false);
  const current = parseProjectIcon(icon);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipHint label={label}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className="cursor-pointer rounded-[28%] transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ProjectIcon project={{ icon: icon ?? null }} size="tile" />
            </button>
          }
        />
      </TooltipHint>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-8 gap-1">
          {PROJECT_ICONS.map((key) => {
            const Glyph = PROJECT_ICON_COMPONENTS[key];
            const selected = current === key;
            const name = t(($) => $.icon_picker.glyphs[key]);
            return (
              <TooltipHint key={key} label={name}>
                <button
                  type="button"
                  aria-label={name}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-lg transition-colors",
                    selected
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Glyph className="size-4" strokeWidth={1.75} />
                </button>
              </TooltipHint>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
