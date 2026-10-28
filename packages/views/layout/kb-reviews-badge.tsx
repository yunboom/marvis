"use client";

import { useWorkspacePaths } from "@marvis/core/paths";
import type { KnowledgeBase } from "@marvis/core/types";
import { CountBadge } from "@marvis/ui/components/common/count-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import { useT } from "../i18n";

// Sits over the right end of the nav row as its sibling, so activating the
// badge never also follows the row's link.
const BADGE_CONTROL =
  "absolute top-1/2 right-2 flex -translate-y-1/2 items-center rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden";

/**
 * Sidebar badge counting change requests waiting for review. With one
 * knowledge base holding them it opens that base's reviews; with several it
 * lists them.
 */
export function KbReviewsBadge({ bases, count }: { bases: readonly KnowledgeBase[]; count: number }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { push } = useNavigation();

  const pendingBases = bases.filter((base) => base.pending.open_mrs > 0);
  const label = t(($) => $.sidebar.kb_reviews_badge, { count });
  const badge = <CountBadge count={count} data-testid="kb-open-mr-badge" />;

  const only = pendingBases.length === 1 ? pendingBases[0] : undefined;
  if (only) {
    return (
      <AppLink href={p.kbReviews(only.slug)} aria-label={label} className={BADGE_CONTROL}>
        {badge}
      </AppLink>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label={label} className={cn(BADGE_CONTROL, "cursor-pointer")}>
            {badge}
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        {pendingBases.map((base) => (
          <DropdownMenuItem key={base.id} onClick={() => push(p.kbReviews(base.slug))}>
            <span className="min-w-0 flex-1 truncate">{base.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{base.pending.open_mrs}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
