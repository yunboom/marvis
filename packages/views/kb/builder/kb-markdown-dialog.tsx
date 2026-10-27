"use client";

import { useState } from "react";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { RichContent } from "../../rich-content";
import { useT } from "../../i18n";

type ViewMode = "edit" | "split" | "preview";

/**
 * Enlarged Markdown editing for the purpose and schema (designs 10.5, 1.6):
 * Markdown on the left, the rendered page on the right. Edits go back to the
 * form only on Done. A read-only text (the default schema) shows the preview
 * alone with a single Close. Mount it when it opens: it starts from `value`.
 */
export function KbMarkdownDialog({
  open,
  onOpenChange,
  title,
  value,
  readOnly,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: string;
  readOnly: boolean;
  onDone: (value: string) => void;
}) {
  const { t } = useT("kb");
  const [text, setText] = useState(value);
  const [view, setView] = useState<ViewMode>("split");

  const showEditor = !readOnly && view !== "preview";
  const showPreview = readOnly || view !== "edit";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(780px,90vh)] flex-col gap-0 p-0 sm:max-w-[1180px]" showCloseButton>
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex-1">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {readOnly ? t(($) => $.builder.expand.read_only_hint) : t(($) => $.builder.expand.edit_hint)}
          </DialogDescription>
          {readOnly ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
              {t(($) => $.builder.expand.read_only)}
            </span>
          ) : (
            <Tabs value={view} onValueChange={(next) => setView(next as ViewMode)}>
              <TabsList>
                <TabsTrigger value="edit">{t(($) => $.builder.expand.edit)}</TabsTrigger>
                <TabsTrigger value="split">{t(($) => $.builder.expand.split)}</TabsTrigger>
                <TabsTrigger value="preview">{t(($) => $.builder.expand.preview)}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {showEditor && (
            <textarea
              aria-label={title}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={cn(
                "min-h-0 flex-1 resize-none bg-muted/30 px-6 py-5 font-mono text-label leading-7 outline-none",
                showPreview && "border-r",
              )}
            />
          )}
          {showPreview && (
            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5" data-testid="kb-markdown-preview">
              <RichContent content={readOnly ? value : text} density="document" phase="settled" />
            </div>
          )}
        </div>

        <DialogFooter className="items-center border-t px-5 py-3">
          <span className="mr-auto text-caption text-faint-foreground">
            {readOnly ? t(($) => $.builder.expand.read_only_hint) : t(($) => $.builder.expand.edit_hint)}
          </span>
          {readOnly ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(($) => $.builder.expand.close)}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t(($) => $.builder.expand.cancel)}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onDone(text);
                  onOpenChange(false);
                }}
              >
                {t(($) => $.builder.expand.done)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
