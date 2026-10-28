"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useWorkspacePaths } from "@marvis/core/paths";
import { Button } from "@marvis/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@marvis/ui/components/ui/popover";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

/**
 * The tree row's "+" (designs 4.1–4.3): say what to write under this page,
 * then a new-page job opens with the request written out; the member picks
 * the agent there and sends.
 */
export function KbNewPagePopover({ kbSlug, parentId, parentTitle }: { kbSlug: string; parentId: string; parentTitle: string }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const handOff = () => {
    const request = text.trim();
    if (!request) return;
    setOpen(false);
    setText("");
    push(
      p.kbNewJob(kbSlug, {
        starter: "new_page",
        page: parentId,
        message: request,
      }),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.job.entry.write_here)}
            title={t(($) => $.job.entry.write_here)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-faint-foreground opacity-0 group-hover/tree:opacity-100 hover:bg-surface-selected hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100"
          />
        }
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="flex w-[360px] flex-col gap-2.5 p-3.5">
        <div className="text-label">
          {t(($) => $.job.entry.write_under, { title: parentTitle })}
        </div>
        <Textarea
          aria-label={t(($) => $.job.entry.write_label)}
          rows={3}
          value={text}
          autoFocus
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) handOff();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t(($) => $.job.entry.cancel)}
          </Button>
          <Button type="button" size="sm" disabled={!text.trim()} onClick={handOff}>
            {t(($) => $.job.entry.write_submit)}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
