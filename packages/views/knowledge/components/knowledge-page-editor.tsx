"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeKeys, type KnowledgePage } from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { useT } from "../../i18n";

/** Markdown editor for one page; saving opens a change request instead of writing main. */
export function KnowledgePageEditor({
  page,
  onDone,
  onSubmitted,
}: {
  page: KnowledgePage;
  onDone: () => void;
  onSubmitted: (number: number) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [text, setText] = useState(page.markdown);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const change = await api.submitKnowledgeEdit({
        path: page.path,
        content: text,
        base_commit: page.commit,
        title: t(($) => $.edit.change_title, { title: page.title }),
      });
      await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
      if (change) {
        toast.success(t(($) => $.edit.submitted, { number: change.number }));
        onSubmitted(change.number);
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.edit.failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col px-7 py-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-semibold">{t(($) => $.edit.title, { title: page.title })}</span>
        <span className="truncate font-mono text-caption text-muted-foreground">{page.path}</span>
        <div className="flex-1" />
        <Button variant="outline" onClick={onDone}>
          {t(($) => $.common.cancel)}
        </Button>
        <Button disabled={text === page.markdown || saving} aria-busy={saving} onClick={() => void submit()}>
          {t(($) => $.edit.submit)}
        </Button>
      </div>
      <Textarea
        aria-label={t(($) => $.edit.label)}
        className="min-h-0 flex-1 font-mono text-label leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-2 text-caption text-muted-foreground">{t(($) => $.edit.hint)}</p>
    </div>
  );
}
