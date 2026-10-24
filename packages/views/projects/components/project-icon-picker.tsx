"use client";

import { useState } from "react";
import {
  parseProjectIcon,
  PROJECT_GLYPHS,
  projectGlyphIcon,
} from "@marvis/core/projects/config";
import { EmojiPicker } from "@marvis/ui/components/common/emoji-picker";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { Popover, PopoverContent, PopoverTrigger } from "@marvis/ui/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { PROJECT_GLYPH_COMPONENTS, ProjectIcon } from "./project-icon";

type PickerTab = "glyph" | "emoji";

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
  const [tab, setTab] = useState<PickerTab>("glyph");

  const handleOpenChange = (next: boolean) => {
    if (next) setTab(current?.kind === "emoji" ? "emoji" : "glyph");
    setOpen(next);
  };

  const select = (value: string) => {
    onChange(value);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <TooltipHint label={label}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="cursor-pointer rounded-lg p-1 -ml-1 hover:bg-accent/60 transition-colors"
              aria-label={label}
            >
              <ProjectIcon project={{ icon: icon ?? null }} size="lg" />
            </button>
          }
        />
      </TooltipHint>
      <PopoverContent align="start" className="w-auto p-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as PickerTab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="glyph">{t(($) => $.icon_picker.tab_glyph)}</TabsTrigger>
            <TabsTrigger value="emoji">{t(($) => $.icon_picker.tab_emoji)}</TabsTrigger>
          </TabsList>
          <TabsContent value="glyph">
            <div className="grid grid-cols-8 gap-1 pt-1">
              {PROJECT_GLYPHS.map((glyph) => {
                const Glyph = PROJECT_GLYPH_COMPONENTS[glyph];
                const selected = current?.kind === "glyph" && current.glyph === glyph;
                const name = t(($) => $.icon_picker.glyphs[glyph]);
                return (
                  <TooltipHint key={glyph} label={name}>
                    <button
                      type="button"
                      aria-label={name}
                      aria-pressed={selected}
                      onClick={() => select(projectGlyphIcon(glyph))}
                      className={cn(
                        "inline-flex size-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent",
                        selected && "bg-accent ring-1 ring-foreground/20",
                      )}
                    >
                      <Glyph className="size-4" strokeWidth={1.75} />
                    </button>
                  </TooltipHint>
                );
              })}
            </div>
          </TabsContent>
          <TabsContent value="emoji">
            <EmojiPicker onSelect={select} />
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
