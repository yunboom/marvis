"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";

/**
 * Chrome of the builder routes: back, the flow title, and the controls of
 * where the builder runs. Below 42rem of its own width the controls take a
 * full row of their own.
 */
export function KbBuilderShell({
  creating,
  subtitle,
  onBack,
  controls,
  controlsAlign,
  children,
}: {
  creating: boolean;
  /** Under the title: how the page works, or the base's name. */
  subtitle: string;
  onBack: () => void;
  /** The runtime and model controls, placed and sized here. */
  controls?: ReactNode;
  /**
   * Lines the controls up with the configuration content below: their total
   * width and the header's right inset. Omitted on narrow layouts, where the
   * controls take a full row.
   */
  controlsAlign?: { width: number; insetRight: number };
  children: ReactNode;
}) {
  const { t } = useT("kb");
  const { t: tAgents } = useT("agents");

  return (
    <div className="@container flex min-h-0 flex-1 flex-col bg-background">
      <header
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 border-b px-5 py-3"
        style={controlsAlign ? { paddingRight: controlsAlign.insetRight } : undefined}
      >
        <IconButton
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          label={tAgents(($) => $.creation_studio.back)}
          tooltipSide="bottom"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold">
            {creating ? t(($) => $.builder.create_title) : t(($) => $.builder.config_title)}
          </h1>
          <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
        </div>
        {controls ? (
          <div
            className={cn("w-full min-w-0 shrink-0 *:w-full", !controlsAlign && "@2xl:w-103")}
            style={controlsAlign ? { width: controlsAlign.width } : undefined}
          >
            {controls}
          </div>
        ) : null}
      </header>
      {children}
    </div>
  );
}

const PANES = ["chat", "config"] as const;

/** Narrow layout: switches between the conversation and the configuration. */
export function KbBuilderPaneTabs({
  pane,
  onChange,
}: {
  pane: "chat" | "config";
  onChange: (pane: "chat" | "config") => void;
}) {
  const { t } = useT("kb");

  return (
    <div role="tablist" aria-label={t(($) => $.builder.tabs.label)} className="flex shrink-0 gap-1 px-4 pt-2.5">
      {PANES.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={pane === id}
          onClick={() => onChange(id)}
          className={cn(
            "h-9 flex-1 rounded-full text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pane === id ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-surface-hover",
          )}
        >
          {id === "chat" ? t(($) => $.builder.tabs.chat) : t(($) => $.builder.tabs.config)}
        </button>
      ))}
    </div>
  );
}
