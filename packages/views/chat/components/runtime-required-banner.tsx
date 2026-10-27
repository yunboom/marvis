"use client";

import { Server } from "lucide-react";
import { useWorkspacePaths } from "@marvis/core/paths";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CHAT_COLUMN, CHAT_GUTTER } from "./chat-column";

export function RuntimeRequiredBanner({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName?: string;
}) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();
  const name = agentName?.trim() || t(($) => $.runtime_required_banner.fallback_name);

  return (
    <div className={cn(CHAT_GUTTER, "mb-2")}>
      <div
        className={cn(
          CHAT_COLUMN,
          "flex items-center gap-2 rounded-lg bg-warning/10 py-1.5 pr-1.5 pl-3 text-label text-amber-900 ring-1 ring-inset ring-warning/30 dark:bg-warning/12 dark:text-amber-200 dark:ring-warning/24",
        )}
      >
        <Server className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(($) => $.runtime_required_banner.message, { name })}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6.5 shrink-0 bg-background px-3 text-caption text-foreground"
          render={
            <AppLink href={`${paths.agentDetail(agentId)}?view=general`} />
          }
          nativeButton={false}
        >
          {t(($) => $.runtime_required_banner.action)}
        </Button>
      </div>
    </div>
  );
}
