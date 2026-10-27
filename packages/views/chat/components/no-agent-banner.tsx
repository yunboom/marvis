"use client";

import { Bot } from "lucide-react";
import { cn } from "@marvis/ui/lib/utils";
import { CHAT_COLUMN, CHAT_GUTTER } from "./chat-column";
import { useT } from "../../i18n";

// Sibling of ChatInput, occupying the same banner slot as OfflineBanner.
// Shown when the workspace has no agent the current user can chat with —
// the input above is disabled, and this banner explains why.
//
// Pure copy by design: the banner doesn't link to /agents because the
// information ("you need an agent") is what's actionable here, not the
// destination — pushing users out of chat to a settings page mid-thought
// is more disruptive than just stating the prerequisite. Users who want
// to act go to Agents on their own.
//
// Layout comes from the shared CHAT_GUTTER / CHAT_COLUMN pair, same as
// OfflineBanner and ChatInput, so the banner's edges line up with the input at
// every surface width.
export function NoAgentBanner() {
  const { t } = useT("chat");
  return (
    <div className={cn(CHAT_GUTTER, "mb-2")}>
      <div className={cn(CHAT_COLUMN, "flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-label text-muted-foreground ring-1 ring-inset ring-border")}>
        <Bot className="size-3.5 shrink-0" />
        <span className="truncate">{t(($) => $.no_agent_banner)}</span>
      </div>
    </div>
  );
}
