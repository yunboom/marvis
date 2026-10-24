"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeChangeOptions, knowledgeHistoryOptions, knowledgeKeys, type KnowledgeBase } from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { KnowledgeDiff } from "./knowledge-diff";

export function KnowledgeHistoryTab({ bases, onReverted }: { bases: KnowledgeBase[]; onReverted: (number: number) => void }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { data: history = [] } = useQuery(knowledgeHistoryOptions(wsId));
  const [selected, setSelected] = useState<number | null>(null);
  const current = selected ?? history[0]?.number ?? null;
  const { data: change } = useQuery(knowledgeChangeOptions(wsId, current));
  const [reverting, setReverting] = useState(false);
  const baseNames = Object.fromEntries(bases.map((b) => [b.slug, b.name]));

  const revert = async () => {
    if (!current) return;
    setReverting(true);
    try {
      const created = await api.revertKnowledgeChange(current);
      await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
      if (created) {
        toast.success(t(($) => $.history.reverted, { number: created.number }));
        onReverted(created.number);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast.error(t(($) => $.history.revert_conflict));
      else toast.error(err instanceof Error ? err.message : t(($) => $.history.revert_failed));
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-96 shrink-0 overflow-y-auto border-r border-border px-2 py-3">
        {history.length === 0 ? (
          <p className="px-2 py-4 text-caption text-muted-foreground">{t(($) => $.history.empty)}</p>
        ) : (
          history.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.number)}
              aria-current={c.number === current ? "true" : undefined}
              className={cn(
                "mb-0.5 flex w-full flex-col gap-0.5 rounded-row px-3 py-2.5 text-left hover:bg-accent",
                c.number === current && "bg-secondary",
              )}
            >
              <span className="flex gap-2">
                <span className="font-mono text-caption text-muted-foreground">{(c.merge_commit ?? "").slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate text-body">{c.title}</span>
              </span>
              <span className="text-caption text-muted-foreground">
                #{c.number} · {t(($) => $.review.sources[c.source])} · {c.author_name} · {(c.merged_at ?? "").slice(0, 10)}
              </span>
            </button>
          ))
        )}
      </div>
      {change ? (
        <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-5 pb-10">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-caption text-muted-foreground">
                {t(($) => $.history.meta, {
                  commit: (change.merge_commit ?? "").slice(0, 7),
                  number: change.number,
                  author: change.author_name,
                })}
              </div>
              <h2 className="mt-1 text-title font-semibold">{change.title}</h2>
            </div>
            <Button variant="outline" disabled={reverting} aria-busy={reverting} onClick={() => void revert()}>
              {t(($) => $.history.revert)}
            </Button>
          </div>
          <p className="mt-1.5 text-caption text-muted-foreground">{t(($) => $.history.revert_hint)}</p>
          <div className="mt-4">
            <KnowledgeDiff change={change} baseNames={baseNames} />
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
