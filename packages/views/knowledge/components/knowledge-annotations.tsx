"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  KNOWLEDGE_ANNOTATION_STATUSES,
  knowledgeAnnotationListOptions,
  knowledgeKeys,
  type KnowledgeAnnotation,
  type KnowledgeAnnotationStatus,
  type KnowledgeBase,
  type KnowledgePage,
} from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { Checkbox } from "@marvis/ui/components/ui/checkbox";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import type { KnowledgeReaderSlots } from "./knowledge-pages-tab";

const OPEN_STATUSES: KnowledgeAnnotationStatus[] = ["pending", "processing"];

const STATUS_DOT: Record<KnowledgeAnnotationStatus, string> = {
  pending: "bg-status-progress",
  processing: "bg-status-review",
  resolved: "bg-status-done",
  dismissed: "bg-status-idle",
};

/** Sentence at a reader key (`section-paragraph-sentence`) plus its neighbours for re-anchoring. */
function sentenceAt(page: KnowledgePage, key: string) {
  const [si = 0, pi = 0, ji = 0] = key.split("-").map(Number);
  const para = page.sections[si]?.paragraphs[pi] ?? [];

  return { quote: para[ji]?.text ?? "", prefix: para[ji - 1]?.text ?? "", suffix: para[ji + 1]?.text ?? "" };
}

function Composer({
  quote,
  onCancel,
  onSave,
}: {
  quote?: string;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
}) {
  const { t } = useT("knowledge");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <div className="my-3 rounded-lg border border-border bg-background p-3 shadow-control">
      {quote ? (
        <div className="mb-2 border-l-2 border-status-review pl-2 text-caption text-muted-foreground">{quote}</div>
      ) : (
        <div className="mb-2 text-caption text-muted-foreground">{t(($) => $.annotations.page_level)}</div>
      )}
      <Textarea
        aria-label={t(($) => $.annotations.body_label)}
        rows={2}
        autoFocus
        value={body}
        placeholder={t(($) => $.annotations.body_placeholder)}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t(($) => $.common.cancel)}
        </Button>
        <Button
          size="sm"
          disabled={!body.trim() || saving}
          aria-busy={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(body.trim());
            } finally {
              setSaving(false);
            }
          }}
        >
          {t(($) => $.annotations.add)}
        </Button>
      </div>
    </div>
  );
}

export function AnnotationCard({
  annotation,
  selectable,
  checked,
  onCheckedChange,
  actions,
}: {
  annotation: KnowledgeAnnotation;
  selectable?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  actions?: ReactNode;
}) {
  const { t } = useT("knowledge");
  const pageLevel = !annotation.quote || annotation.anchor_lost;

  return (
    <div className="flex items-start gap-3">
      {selectable ? (
        <Checkbox
          aria-label={t(($) => $.annotations.select)}
          checked={!!checked}
          onCheckedChange={(v) => onCheckedChange?.(!!v)}
          className="mt-0.5"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
          <span className="text-foreground">{annotation.author_name || t(($) => $.annotations.unknown_author)}</span>
          {annotation.author_type === "agent" ? <span>{t(($) => $.annotations.agent)}</span> : null}
          <span>{annotation.created_at.slice(0, 16).replace("T", " ")}</span>
          <span className="ml-auto flex items-center gap-1">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT[annotation.status])} />
            {t(($) => $.annotations.status[annotation.status])}
          </span>
        </div>
        {pageLevel ? (
          <div className="mt-1.5 text-caption text-muted-foreground">
            {annotation.anchor_lost ? t(($) => $.annotations.anchor_lost) : t(($) => $.annotations.page_level)}
          </div>
        ) : (
          <div className="mt-1.5 border-l-2 border-border pl-2 text-caption text-muted-foreground">{annotation.quote}</div>
        )}
        {annotation.anchor_lost && annotation.quote ? (
          <div className="mt-1 text-caption text-muted-foreground line-through">{annotation.quote}</div>
        ) : null}
        <p className="mt-1 text-body">{annotation.body}</p>
        {actions ? <div className="mt-1.5 flex flex-wrap gap-1.5">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * Reader slots that turn sentences into annotation anchors: click a sentence to
 * comment on it, or annotate the whole page; the rail lists open annotations.
 */
export function useAnnotationSlots(
  kb: KnowledgeBase,
  submit?: (annotations: KnowledgeAnnotation[]) => void,
): KnowledgeReaderSlots {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<{ path: string; key: string } | null>(null);
  const [pageComposer, setPageComposer] = useState<string | null>(null);
  const { data: all = [] } = useQuery(knowledgeAnnotationListOptions(wsId, kb.id));

  const openFor = (path: string) => all.filter((a) => a.page_path === path && OPEN_STATUSES.includes(a.status));

  const save = async (page: KnowledgePage, body: string, anchor?: ReturnType<typeof sentenceAt>) => {
    try {
      await api.createKnowledgeAnnotation(kb.id, { page_path: page.path, body, ...anchor });
      await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
      toast.success(t(($) => $.annotations.added));
      setSelected(null);
      setPageComposer(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.annotations.add_failed));
    }
  };

  return {
    headerActions: (page) => (
      <Button size="xs" variant="ghost" onClick={() => setPageComposer(page.path)}>
        {t(($) => $.annotations.annotate_page)}
      </Button>
    ),
    renderSentence: (page, sentence) => {
      const annotated = openFor(page.path).some((a) => !a.anchor_lost && a.quote === sentence.text);
      const isSelected = selected?.path === page.path && selected.key === sentence.key;

      return (
        <button
          type="button"
          onClick={() => {
            setPageComposer(null);
            setSelected({ path: page.path, key: sentence.key });
          }}
          className={cn(
            "rounded-[3px] text-left transition-colors hover:bg-status-progress/10",
            annotated && "border-b-[1.5px] border-status-progress bg-status-progress/15",
            isSelected && "bg-status-review/20",
          )}
        >
          {sentence.text}
        </button>
      );
    },
    afterSection: (page, sectionIndex) => {
      if (pageComposer === page.path && sectionIndex === 0) {
        return <Composer onCancel={() => setPageComposer(null)} onSave={(body) => save(page, body)} />;
      }
      if (!selected || selected.path !== page.path || !selected.key.startsWith(`${sectionIndex}-`)) return null;
      const anchor = sentenceAt(page, selected.key);

      return <Composer quote={anchor.quote} onCancel={() => setSelected(null)} onSave={(body) => save(page, body, anchor)} />;
    },
    rail: (page) => {
      const open = openFor(page.path);
      const pending = open.filter((a) => a.status === "pending");

      return (
        <aside aria-label={t(($) => $.annotations.rail_label)} className="w-72 shrink-0 overflow-y-auto border-l border-border bg-muted/20 px-3.5 py-4">
          <div className="mb-3 flex items-center gap-1.5">
            <span className="font-medium">{t(($) => $.annotations.rail_title)}</span>
            <span className="text-caption text-muted-foreground">{open.length}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {open.map((a) => (
              <div key={a.id} className="rounded-lg border border-border bg-background p-3">
                <AnnotationCard annotation={a} />
              </div>
            ))}
          </div>
          {open.length === 0 ? <p className="text-caption text-muted-foreground">{t(($) => $.annotations.rail_empty)}</p> : null}
          {submit && pending.length > 0 ? (
            <Button className="mt-3 w-full" onClick={() => submit(pending)}>
              {t(($) => $.annotations.submit_n, { n: pending.length })}
            </Button>
          ) : null}
        </aside>
      );
    },
  };
}

export function KnowledgeAnnotationsTab({
  kb,
  onOpenPage,
  onOpenChange,
  submit,
}: {
  kb: KnowledgeBase;
  onOpenPage: (path: string) => void;
  onOpenChange: (number: number) => void;
  submit?: (annotations: KnowledgeAnnotation[]) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [status, setStatus] = useState<KnowledgeAnnotationStatus>("pending");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const { data: all = [] } = useQuery(knowledgeAnnotationListOptions(wsId, kb.id));
  const rows = all.filter((a) => a.status === status);
  const selected = rows.filter((a) => checked[a.id]);

  const setAnnotationStatus = async (a: KnowledgeAnnotation, next: "dismissed" | "pending") => {
    try {
      await api.updateKnowledgeAnnotation(a.id, next);
      await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.annotations.update_failed));
    }
  };

  return (
    <div className={cn("flex-1 overflow-y-auto py-4", PAGE_GUTTER)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t(($) => $.annotations.filter)} className="flex gap-1">
          {KNOWLEDGE_ANNOTATION_STATUSES.map((s) => (
            <Button
              key={s}
              size="xs"
              role="radio"
              aria-checked={status === s}
              variant={status === s ? "secondary" : "ghost"}
              onClick={() => {
                setStatus(s);
                setChecked({});
              }}
            >
              {t(($) => $.annotations.status[s])}
              <span className="text-muted-foreground">{all.filter((a) => a.status === s).length}</span>
            </Button>
          ))}
        </div>
        <div className="flex-1" />
        {selected.length > 0 ? (
          <span className="text-body text-muted-foreground">{t(($) => $.annotations.selected_n, { n: selected.length })}</span>
        ) : null}
        {submit ? (
          <Button disabled={selected.length === 0} onClick={() => submit(selected)}>
            {t(($) => $.annotations.submit)}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.annotations.empty)}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <AnnotationCard
                annotation={a}
                selectable={a.status === "pending"}
                checked={!!checked[a.id]}
                onCheckedChange={(v) => setChecked((c) => ({ ...c, [a.id]: v }))}
                actions={
                  <>
                    <Button size="xs" variant="ghost" onClick={() => onOpenPage(a.page_path)}>
                      {a.page_title || a.page_path}
                    </Button>
                    {a.change_number ? (
                      <Button size="xs" variant="ghost" onClick={() => onOpenChange(a.change_number ?? 0)}>
                        {t(($) => $.annotations.change_n, { number: a.change_number })}
                      </Button>
                    ) : null}
                    {a.status === "pending" ? (
                      <Button size="xs" variant="ghost" onClick={() => void setAnnotationStatus(a, "dismissed")}>
                        {t(($) => $.annotations.dismiss)}
                      </Button>
                    ) : null}
                    {a.status === "dismissed" ? (
                      <Button size="xs" variant="ghost" onClick={() => void setAnnotationStatus(a, "pending")}>
                        {t(($) => $.annotations.reopen)}
                      </Button>
                    ) : null}
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
