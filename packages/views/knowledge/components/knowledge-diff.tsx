"use client";

import { Fragment, useState } from "react";
import type { KnowledgeChangeComment, KnowledgeChangeDetail, KnowledgeDiffLine } from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";

const LINE_CLASS: Record<KnowledgeDiffLine["kind"], string> = {
  context: "",
  add: "bg-status-done/10",
  delete: "bg-status-blocked/10",
};

const SIGN: Record<KnowledgeDiffLine["kind"], string> = { context: " ", add: "+", delete: "-" };

/**
 * Change request diff grouped by knowledge base. Clicking a line number on the
 * new side opens a review comment composer when `onComment` is given.
 */
export function KnowledgeDiff({
  change,
  baseNames,
  onComment,
}: {
  change: KnowledgeChangeDetail;
  baseNames: Record<string, string>;
  onComment?: (path: string, line: number, body: string) => Promise<void>;
}) {
  const { t } = useT("knowledge");
  const [composer, setComposer] = useState<{ path: string; line: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const commentsAt = (path: string, line: number): KnowledgeChangeComment[] =>
    change.comments.filter((c) => c.path === path && c.line === line);

  const save = async () => {
    if (!composer || !onComment) return;
    setSaving(true);
    try {
      await onComment(composer.path, composer.line, draft.trim());
      setDraft("");
      setComposer(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {change.groups.map((group) => (
        <section key={group.slug}>
          <h3 className="mb-2 text-label font-semibold">{baseNames[group.slug] ?? group.slug}</h3>
          {group.files.map((file) => (
            <div key={file.path} className="mb-3 overflow-hidden rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-caption">{file.path}</span>
                <span className="text-caption text-status-done">+{file.added}</span>
                <span className="text-caption text-status-blocked">-{file.deleted}</span>
              </div>
              {file.binary ? (
                <p className="px-3 py-2 text-caption text-muted-foreground">{t(($) => $.review.binary)}</p>
              ) : (
                <div className="font-mono text-caption">
                  {file.lines.map((line, i) => {
                    const commentable = !!onComment && line.kind !== "delete" && line.new_line > 0;
                    const lineNo = line.kind === "delete" ? line.old_line : line.new_line;
                    const comments = line.kind === "delete" ? [] : commentsAt(file.path, line.new_line);
                    const open = composer?.path === file.path && composer.line === line.new_line && line.kind !== "delete";
                    return (
                      <Fragment key={i}>
                        <div className={cn("flex leading-6", LINE_CLASS[line.kind])}>
                          {commentable ? (
                            <button
                              type="button"
                              aria-label={t(($) => $.review.comment_on_line, { line: lineNo })}
                              onClick={() => {
                                setComposer({ path: file.path, line: line.new_line });
                                setDraft("");
                              }}
                              className="w-11 shrink-0 pr-2.5 text-right text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              {lineNo}
                            </button>
                          ) : (
                            <span className="w-11 shrink-0 pr-2.5 text-right text-muted-foreground">{lineNo || ""}</span>
                          )}
                          <span aria-hidden="true" className="w-4 shrink-0 text-muted-foreground">{SIGN[line.kind]}</span>
                          <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">{line.text}</span>
                        </div>
                        {comments.map((c) => (
                          <div key={c.id} className="mx-3 my-1.5 ml-[60px] rounded-lg bg-muted px-3 py-2 font-sans text-body">
                            {c.body}
                          </div>
                        ))}
                        {open ? (
                          <div className="mx-3 my-2 ml-[60px] font-sans">
                            <Textarea
                              aria-label={t(($) => $.review.comment_label)}
                              rows={2}
                              autoFocus
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              placeholder={t(($) => $.review.comment_placeholder)}
                            />
                            <div className="mt-1.5 flex justify-end gap-2">
                              <Button size="sm" variant="outline" onClick={() => setComposer(null)}>
                                {t(($) => $.common.cancel)}
                              </Button>
                              <Button size="sm" disabled={!draft.trim() || saving} aria-busy={saving} onClick={() => void save()}>
                                {t(($) => $.review.comment)}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
