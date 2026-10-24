"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  knowledgeChangeListOptions,
  knowledgeChangeOptions,
  knowledgeKeys,
  type KnowledgeBase,
  type KnowledgeChangeDetail,
  type KnowledgeChangeRequest,
} from "@marvis/core/knowledge";
import { useCurrentMember } from "@marvis/core/permissions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { canAdministerWorkspace } from "../lib/permissions";
import { KnowledgeDiff } from "./knowledge-diff";

type ReviewFilter = "open" | "done" | "all";

const STATUS_DOT = {
  open: "bg-status-review",
  conflict: "bg-status-blocked",
  merged: "bg-status-done",
  closed: "bg-status-idle",
} as const;

function dotFor(change: KnowledgeChangeRequest) {
  if (change.status === "open") return change.conflict ? STATUS_DOT.conflict : STATUS_DOT.open;
  return STATUS_DOT[change.status];
}

export function useSelectedChange(): [number | null, (n: number | null) => void] {
  const navigation = useNavigation();
  const raw = new URLSearchParams(navigation.searchParams).get("change");
  const selected = raw ? Number(raw) || null : null;
  const select = (n: number | null) => {
    const next = new URLSearchParams(navigation.searchParams);
    if (n) next.set("change", String(n));
    else next.delete("change");
    navigation.replace(`${navigation.pathname}${next.size ? `?${next}` : ""}${navigation.hash}`);
  };

  return [selected, select];
}

export interface KnowledgeReviewSlots {
  /** Action shown on a conflicting change (ask the agent to rebase). */
  conflictAction?: (change: KnowledgeChangeDetail) => ReactNode;
  /** Link back to the session that produced the change. */
  sessionAction?: (change: KnowledgeChangeDetail) => ReactNode;
}

export function KnowledgeReviewTab({ bases, slots = {} }: { bases: KnowledgeBase[]; slots?: KnowledgeReviewSlots }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const [filter, setFilter] = useState<ReviewFilter>("open");
  const [selected, select] = useSelectedChange();
  const { data: all = [] } = useQuery(knowledgeChangeListOptions(wsId, "all"));

  const changes = all.filter((c) => (filter === "all" ? true : filter === "open" ? c.status === "open" : c.status !== "open"));
  const current = selected ?? changes[0]?.number ?? null;
  const baseNames = Object.fromEntries(bases.map((b) => [b.slug, b.name]));

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-80 shrink-0 flex-col border-r border-border">
        <div role="radiogroup" aria-label={t(($) => $.review.filter)} className="flex gap-1 px-3 pt-3 pb-2">
          {(["open", "done", "all"] as const).map((f) => (
            <Button key={f} size="xs" role="radio" aria-checked={filter === f} variant={filter === f ? "secondary" : "ghost"} onClick={() => setFilter(f)}>
              {t(($) => $.review.filters[f])}
            </Button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {changes.length === 0 ? (
            <p className="px-2 py-4 text-caption text-muted-foreground">{t(($) => $.review.empty)}</p>
          ) : (
            changes.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => select(c.number)}
                aria-current={c.number === current ? "true" : undefined}
                className={cn(
                  "mb-0.5 flex w-full flex-col gap-1 rounded-row px-3 py-2.5 text-left transition-colors hover:bg-accent",
                  c.number === current && "bg-secondary",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-caption text-muted-foreground">#{c.number}</span>
                  <span className="min-w-0 flex-1 truncate text-body font-medium">{c.title}</span>
                </span>
                <span className="flex items-center gap-2 text-caption text-muted-foreground">
                  <span>{t(($) => $.review.sources[c.source])}</span>
                  <span className="truncate">{c.author_name}</span>
                  <span className="truncate">{c.kb_slugs.map((s) => baseNames[s] ?? s).join("、")}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotFor(c))} />
                    {t(($) => $.review.states[c.status === "open" && c.conflict ? "conflict" : c.status])}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      {current ? <ChangeDetail number={current} baseNames={baseNames} slots={slots} /> : <div className="flex-1" />}
    </div>
  );
}

function ChangeDetail({ number, baseNames, slots }: { number: number; baseNames: Record<string, string>; slots: KnowledgeReviewSlots }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { userId, role } = useCurrentMember(wsId);
  const { data: change } = useQuery(knowledgeChangeOptions(wsId, number));
  const [busy, setBusy] = useState<"merge" | "close" | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  if (!change) return <div className="flex-1" />;

  const isAdmin = canAdministerWorkspace(role);
  const isAuthor = change.author_type === "member" && change.author_id === userId;
  const refresh = () => qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });

  const run = async (kind: "merge" | "close") => {
    setBusy(kind);
    try {
      if (kind === "merge") await api.mergeKnowledgeChange(number);
      else await api.closeKnowledgeChange(number);
      toast.success(t(($) => (kind === "merge" ? $.review.merged : $.review.closed), { number }));
      setConfirmClose(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast.error(t(($) => $.review.merge_conflict));
      else toast.error(err instanceof Error ? err.message : t(($) => $.review.action_failed));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const open = change.status === "open";
  const mergeBlocked = !isAdmin || change.conflict;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-5 pb-10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-caption text-muted-foreground">
            #{change.number} · {t(($) => $.review.sources[change.source])} · {change.author_name} · {change.created_at.slice(0, 16).replace("T", " ")}
          </div>
          <h2 className="mt-1 text-title font-semibold">{change.title}</h2>
        </div>
        {open ? (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              {isAdmin || isAuthor ? (
                <Button variant="outline" disabled={!!busy} onClick={() => setConfirmClose(true)}>
                  {t(($) => $.review.close)}
                </Button>
              ) : null}
              <Button disabled={mergeBlocked || !!busy} aria-busy={busy === "merge"} onClick={() => void run("merge")}>
                {busy === "merge" ? t(($) => $.review.merging) : t(($) => $.review.merge)}
              </Button>
            </div>
            {mergeBlocked ? (
              <span className="text-caption text-muted-foreground">
                {!isAdmin ? t(($) => $.review.needs_admin) : t(($) => $.review.resolve_first)}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotFor(change))} />
            {t(($) => $.review.states[change.status])}
          </span>
        )}
      </div>

      {open && change.conflict ? (
        <div role="alert" className="mt-4 flex items-center gap-3 rounded-lg bg-status-blocked/10 px-4 py-3">
          <span className="min-w-0 flex-1 text-body">
            {t(($) => $.review.conflict, { files: change.conflict_files.join("、") })}
          </span>
          {slots.conflictAction?.(change)}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <div className="mb-1.5 text-caption text-muted-foreground">{t(($) => $.review.self_review)}</div>
          <p className="text-body whitespace-pre-line">{change.summary || t(($) => $.review.no_summary)}</p>
          <div className="mt-2 text-caption text-muted-foreground">
            {t(($) => $.review.risk_files, {
              risk: t(($) => $.review.risks[change.risk]),
              files: change.groups.reduce((n, g) => n + g.files.length, 0),
            })}
          </div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="mb-1.5 text-caption text-muted-foreground">{t(($) => $.review.checks)}</div>
          <div className="flex items-center gap-2 text-body">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", change.conflict ? "bg-status-blocked" : "bg-status-done")} />
            {change.conflict ? t(($) => $.review.check_conflict) : t(($) => $.review.check_mergeable)}
          </div>
          {change.annotation_ids.length > 0 ? (
            <div className="mt-2 text-caption text-muted-foreground">
              {t(($) => $.review.handles_annotations, { n: change.annotation_ids.length })}
            </div>
          ) : null}
          {slots.sessionAction ? <div className="mt-3">{slots.sessionAction(change)}</div> : null}
        </div>
      </div>

      <div className="mt-5">
        <KnowledgeDiff
          change={change}
          baseNames={baseNames}
          onComment={
            open
              ? async (path, line, body) => {
                  await api.commentOnKnowledgeChange(number, { path, line, body });
                  await refresh();
                }
              : undefined
          }
        />
      </div>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.review.close_title, { number })}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.review.close_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.common.cancel)}</AlertDialogCancel>
            <Button variant="destructive" disabled={busy === "close"} aria-busy={busy === "close"} onClick={() => void run("close")}>
              {t(($) => $.review.close)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
