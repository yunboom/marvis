"use client";

import { useState } from "react";
import { ChevronRight, Info, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@marvis/ui/components/ui/dialog";
import { copyText } from "@marvis/ui/lib/clipboard";
import { cn } from "@marvis/ui/lib/utils";
import { useLocale } from "../../i18n";

// The desktop app is not signed with an Apple Developer ID yet, so Gatekeeper
// quarantines it on first launch. Clearing the quarantine attribute is the
// one-time fix; it also means Squirrel.Mac cannot auto-update the app.
const MAC_QUARANTINE_FIX_CMD = "xattr -cr /Applications/Marvis.app";

const COPIED_RESET_MS = 1800;

/**
 * Brand-tinted pill that opens the first-launch instructions for the unsigned
 * macOS build. `lg` sits under the download hero; `sm` sits beside each Mac
 * row in a platform list.
 */
export function MacHintTrigger({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { t } = useLocale();
  const d = t.download.macHint;

  return (
    <Dialog>
      <DialogTrigger
        className={cn(
          "inline-flex items-center rounded-full bg-[#f2ebe7] font-medium text-[#7b4835] transition-colors hover:bg-[#ead9cf]",
          size === "lg"
            ? "h-[34px] gap-1.5 pl-2.5 pr-3.5 text-[13px]"
            : "h-6 gap-1 pl-2 pr-2.5 text-[12px]",
        )}
      >
        <Info className={size === "lg" ? "size-4" : "size-3"} aria-hidden />
        {d.trigger}
        {size === "lg" ? (
          <ChevronRight className="size-3.5" aria-hidden />
        ) : null}
      </DialogTrigger>
      <MacHintContent />
    </Dialog>
  );
}

function MacHintContent() {
  const { t } = useLocale();
  const d = t.download.macHint;
  const steps = [d.stepInstall, d.stepCommand, d.stepReopen];

  return (
    <DialogContent
      showCloseButton={false}
      className="landing-light flex max-w-[440px] flex-col gap-5 rounded-(--landing-radius-panel) bg-white p-7 text-[#0f0f0f] shadow-[0_24px_64px_rgba(0,0,0,0.16)] ring-0 sm:max-w-[440px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-[20px] font-semibold">
            {d.title}
          </DialogTitle>
          <DialogDescription className="text-[14px] text-[#666]">
            {d.sub}
          </DialogDescription>
        </div>
        <DialogClose
          aria-label={d.close}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#f2f2f2] hover:bg-[#e8e8e8]"
        >
          <X className="size-3.5" aria-hidden />
        </DialogClose>
      </div>

      <ol className="flex flex-col gap-3.5">
        {steps.map((step, i) => (
          <li key={step} className="flex items-start gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#f2ebe7] text-[12px] font-semibold text-[#7b4835]">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-[15px]">{step}</span>
              {step === d.stepCommand ? <CommandCopy /> : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-1.5 border-t border-black/6 pt-4 text-[13px] text-[#666]">
        <span>{d.altSettings}</span>
        <span>{d.noAutoUpdate}</span>
      </div>

      <DialogClose className="inline-flex h-10 items-center self-end rounded-full bg-[#0f0f0f] px-[22px] text-[14px] font-medium text-white hover:bg-[#0f0f0f]/88">
        {d.confirm}
      </DialogClose>
    </DialogContent>
  );
}

function CommandCopy() {
  const { t } = useLocale();
  const d = t.download.macHint;
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (await copyText(MAC_QUARANTINE_FIX_CMD)) {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-(--landing-radius-action) bg-[#f7f7f7] py-2 pl-3.5 pr-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px]">
        {MAC_QUARANTINE_FIX_CMD}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="h-[30px] shrink-0 rounded-full bg-white px-3 text-[13px] hover:bg-[#f2f2f2]"
      >
        {copied ? d.copiedLabel : d.copyLabel}
      </button>
    </div>
  );
}
