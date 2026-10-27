"use client";

import { Search } from "lucide-react";
import { SidebarMenuButton } from "@marvis/ui/components/ui/sidebar";
import {
  useShortcut,
} from "@marvis/core/shortcuts";
import { useSearchStore } from "./search-store";
import { useT } from "../i18n";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";

export function SearchTrigger() {
  const { t } = useT("search");
  const shortcut = useShortcut("openSearch");
  return (
    <SidebarMenuButton
      className="h-10 gap-2.5 rounded-lg border border-input bg-transparent px-3 text-body text-muted-foreground hover:border-black/20 hover:bg-transparent hover:text-foreground dark:hover:border-white/20 [&_svg]:size-[18px]"
      onClick={() => useSearchStore.getState().setOpen(true)}
    >
      <Search />
      <span>{t(($) => $.trigger.label)}</span>
      {shortcut ? (
        <ShortcutKeycaps shortcut={shortcut} decorative className="pointer-events-none ml-auto" />
      ) : null}
    </SidebarMenuButton>
  );
}
