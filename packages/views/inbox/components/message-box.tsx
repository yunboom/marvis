"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useModalStore } from "@marvis/core/modals";
import { useMessageBoxStore } from "@marvis/core/inbox/message-box-store";
import { isPortalLayerShortcutTarget } from "@marvis/core/shortcuts";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { InboxPage, MESSAGE_BOX_LAYER_ATTR } from "./inbox-page";

/**
 * The inbox as a dialog over the current page, opened from the sidebar bell.
 *
 * Non-modal on purpose: the issue detail inside opens modals of its own
 * (rename, delete, set parent) through `ModalRegistry`, and a modal dialog
 * here would trap their focus and read clicks in them as outside presses. The
 * overlay still covers the page, so the box looks and dismisses like a modal.
 */
export function MessageBox() {
  const { t } = useT("inbox");
  const open = useMessageBoxStore((s) => s.open);
  const setOpen = useMessageBoxStore((s) => s.setOpen);
  const { pathname } = useNavigation();
  // Opening focuses the box itself: the first control is the filter button,
  // and focusing it pops its tooltip as soon as the box appears.
  const contentRef = useRef<HTMLDivElement>(null);

  // A link followed from inside (a mention, a project) leaves the page the box
  // was opened over, so the box goes with it.
  const openedAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      openedAtRef.current = null;
      return;
    }
    if (openedAtRef.current === null) {
      openedAtRef.current = pathname;
      return;
    }
    if (pathname !== openedAtRef.current) setOpen(false);
  }, [open, pathname, setOpen]);

  return (
    <Dialog
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (next) {
          setOpen(true);
          return;
        }
        // Focus moving into a modal opened above is not a dismissal.
        if (details.reason === "focus-out") return;
        if (details.reason === "outside-press" || details.reason === "escape-key") {
          if (useModalStore.getState().modal) return;
          // A press or Escape that belongs to another open layer (a modal or
          // menu above the box) is that layer's to handle.
          const box = document.querySelector(`[${MESSAGE_BOX_LAYER_ATTR}]`);
          if (isPortalLayerShortcutTarget(details.event?.target ?? null, box)) return;
        }
        setOpen(false);
      }}
    >
      <DialogContent
        ref={contentRef}
        initialFocus={contentRef}
        showCloseButton={false}
        {...{ [MESSAGE_BOX_LAYER_ATTR]: "" }}
        className="flex h-[min(54rem,calc(100dvh-4rem))] w-[min(84rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{t(($) => $.page.title)}</DialogTitle>
        <InboxPage
          surface="dialog"
          closeAction={
            <DialogClose
              render={
                <IconButton
                  label={t(($) => $.page.close)}
                  tooltipSide="bottom"
                  className="text-muted-foreground"
                />
              }
            >
              <X />
            </DialogClose>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
