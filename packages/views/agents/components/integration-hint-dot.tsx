"use client";

import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";

/**
 * Red dot marking the path to an agent's unvisited Integrations tab (see
 * useAgentIntegrationHints). Inline by default; pass positioning classes to
 * pin it to a corner.
 */
export function IntegrationHintDot({ className }: { className?: string }) {
  const { t } = useT("agents");

  return (
    <span
      role="img"
      aria-label={t(($) => $.tabs.integration_hint)}
      data-testid="agent-integration-hint-dot"
      className={cn("size-2 shrink-0 rounded-full bg-destructive", className)}
    />
  );
}
