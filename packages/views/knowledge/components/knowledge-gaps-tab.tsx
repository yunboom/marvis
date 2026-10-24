"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  knowledgeGapListOptions,
  knowledgeKeys,
  type KnowledgeGap,
  type KnowledgeGapStatus,
} from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";

const STATUS_DOT: Record<KnowledgeGapStatus, string> = {
  open: "bg-status-progress",
  processing: "bg-status-review",
  filled: "bg-status-done",
};

export function KnowledgeGapsTab({ action }: { action?: (openGaps: KnowledgeGap[]) => ReactNode }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [status, setStatus] = useState<KnowledgeGapStatus | "all">("open");
  const { data: gaps = [] } = useQuery(knowledgeGapListOptions(wsId, status));
  const { data: open = [] } = useQuery(knowledgeGapListOptions(wsId, "open"));

  const markFilled = async (gap: KnowledgeGap) => {
    try {
      await api.updateKnowledgeGap(gap.id, "filled");
      await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.gaps.update_failed));
    }
  };

  return (
    <div className={cn("flex-1 overflow-y-auto py-4", PAGE_GUTTER)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t(($) => $.gaps.filter)} className="flex gap-1">
          {(["open", "processing", "filled", "all"] as const).map((s) => (
            <Button key={s} size="xs" role="radio" aria-checked={status === s} variant={status === s ? "secondary" : "ghost"} onClick={() => setStatus(s)}>
              {t(($) => $.gaps.status[s])}
            </Button>
          ))}
        </div>
        <p className="flex-1 text-caption text-muted-foreground">{t(($) => $.gaps.hint)}</p>
        {action?.(open)}
      </div>
      {gaps.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.gaps.empty)}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {gaps.map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 text-body">{g.question}</span>
              <span className="text-caption text-muted-foreground">
                {t(($) => $.gaps.source[g.source === "agent" ? "agent" : "search_miss"])}
              </span>
              <span className="w-24 text-caption text-muted-foreground">{g.created_at.slice(0, 10)}</span>
              <span className="flex w-20 items-center gap-1.5 text-caption text-muted-foreground">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT[g.status])} />
                {t(($) => $.gaps.status[g.status])}
              </span>
              {g.status !== "filled" ? (
                <Button size="xs" variant="ghost" onClick={() => void markFilled(g)}>
                  {t(($) => $.gaps.mark_filled)}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
