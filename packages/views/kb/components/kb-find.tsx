"use client";

import { useEffect, useState, type RefObject } from "react";
import { isEditableShortcutTarget, isPortalLayerShortcutTarget } from "@marvis/core/shortcuts";
import { useT } from "../../i18n";
import { FindBar } from "../../issues/components/find-bar";
import { useInPageFind } from "../../issues/hooks/use-in-page-find";

interface KbFindInPageProps {
  /** The reading page's scroll container; its text is searched. */
  container: RefObject<HTMLElement | null>;
  /** The page being read; changing it closes the bar. */
  pageId: string;
}

/**
 * Find in the knowledge base page being read (the findInIssue shortcut,
 * Mod+F), in place of the browser's find while the page is shown. Rendered as
 * the scroll container's first child: a zero-height sticky row keeps the bar
 * at the top right while the page scrolls under it.
 */
export function KbFindInPage({ container, pageId }: KbFindInPageProps) {
  const { t } = useT("kb");
  const [element, setElement] = useState<HTMLElement | null>(null);

  // The bar renders inside the container, whose ref is attached after this
  // component's layout effects; a passive effect sees it set. Mirroring it
  // into state lets the hook observe the element.
  useEffect(() => {
    setElement(container.current);
  }, [container]);

  const find = useInPageFind({ container: element, contentKey: pageId });
  const { open, closeFind } = find;

  useEffect(() => {
    closeFind();
  }, [pageId, closeFind]);

  // Escape closes the bar even after focus moved from it into the page; the
  // bar's own input handles Escape itself.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isEditableShortcutTarget(event.target) || isPortalLayerShortcutTarget(event.target)) return;

      closeFind();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeFind]);

  if (!open) return null;

  return (
    <div className="sticky top-2 z-20 flex h-0 justify-end pr-4">
      <FindBar find={find} placeholder={t(($) => $.find.placeholder)} className="h-fit" />
    </div>
  );
}
