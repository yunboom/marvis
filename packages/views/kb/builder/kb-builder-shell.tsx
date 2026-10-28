"use client";

import type { ReactNode } from "react";
import { cn } from "@marvis/ui/lib/utils";
import { AgentCreateShell } from "../../agents/create/create-shell";
import { useT } from "../../i18n";

/** Chrome of the builder routes: back and the flow title. */
export function KbBuilderShell({
  creating,
  subtitle,
  onBack,
  children,
}: {
  creating: boolean;
  /** Under the title: how the page works, or the base's name. */
  subtitle: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useT("kb");

  return (
    <AgentCreateShell
      title={creating ? t(($) => $.builder.create_title) : t(($) => $.builder.config_title)}
      step={subtitle}
      onBack={onBack}
    >
      {children}
    </AgentCreateShell>
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
