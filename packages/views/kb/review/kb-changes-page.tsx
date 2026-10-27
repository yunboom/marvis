"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbMergeRequestListOptions, kbMergeRequestOptions } from "@marvis/core/kb/queries";
import type { KbMergeRequest } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbFileCard } from "../components/kb-diff";
import { formatShortDate } from "../components/kb-page-body";
import { useKbSourceLabel } from "./kb-review-detail";
import { parseKbReviewRoute } from "./kb-review-route";
import { KbRevertDialog, type KbRevertTarget } from "./kb-revert-dialog";

function ChangeRow({ kbSlug, mr, selected }: { kbSlug: string; mr: KbMergeRequest; selected: boolean }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const sourceLabel = useKbSourceLabel();

  return (
    <li>
      <AppLink
        href={p.kbChange(kbSlug, mr.number)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex flex-col gap-0.5 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-surface-hover",
          selected && "bg-surface-selected hover:bg-surface-selected",
        )}
      >
        <span className="min-w-0 truncate text-label">{mr.title}</span>
        <span className="truncate text-caption text-faint-foreground">
          {t(($) => $.review.changes.row, {
            number: mr.number,
            source: sourceLabel(mr.source),
            author: mr.author_name,
            date: mr.merged_at ? formatShortDate(mr.merged_at) : "",
          })}
        </span>
      </AppLink>
    </li>
  );
}

function ChangeDetail({ kbSlug, number }: { kbSlug: string; number: number }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { data: mr } = useQuery(kbMergeRequestOptions(wsId, number));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [reverting, setReverting] = useState<KbRevertTarget | null>(null);

  if (!mr || mr.number !== number) return <div className="flex-1" />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-7 py-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-label text-faint-foreground">
            {t(($) => $.review.changes.header, { number: mr.number, author: mr.author_name, merger: mr.merged_by_name })}
          </div>
          <h2 className="mt-1 text-title font-semibold break-words">
            <AppLink href={p.kbMergeRequest(kbSlug, mr.number)} className="hover:underline">
              {mr.title}
            </AppLink>
          </h2>
        </div>
        {mr.can_revert && (
          <Button type="button" variant="outline" onClick={() => setReverting({ number: mr.number, title: mr.title })}>
            {t(($) => $.review.revert)}
          </Button>
        )}
      </div>
      {mr.can_revert && <p className="text-label text-faint-foreground">{t(($) => $.review.changes.revert_hint)}</p>}
      {mr.pages.map((page) => (
        <KbFileCard
          key={page.page_id}
          page={page}
          open={!collapsed.has(page.page_id)}
          onToggle={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(page.page_id)) next.delete(page.page_id);
              else next.add(page.page_id);
              return next;
            })
          }
          href={p.kbPage(kbSlug, page.page_id)}
        />
      ))}
      <KbRevertDialog kbSlug={kbSlug} target={reverting} onClose={() => setReverting(null)} />
    </div>
  );
}

/**
 * The change log (designs 2.7–2.9): merged requests on the left, the
 * selected one's file cards on the right, with revert.
 */
export function KbChangesPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const { kbSlug, number } = parseKbReviewRoute(pathname);
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: list = [], isLoading } = useQuery(kbMergeRequestListOptions(wsId, kbSlug, "merged"));

  const selected = number || list[0]?.number || 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kb()} className="shrink-0 hover:text-foreground">
            {t(($) => $.list.title)}
          </AppLink>
          <span aria-hidden="true">/</span>
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {base?.name ?? kbSlug}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {t(($) => $.review.changes.title)}
          </span>
        </nav>
      </PageHeader>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside
          aria-label={t(($) => $.review.changes.list_label)}
          className="flex w-[340px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r bg-surface-sunken/30 px-2 py-3 max-md:max-h-[40%] max-md:w-full max-md:border-r-0 max-md:border-b"
        >
          {!isLoading && list.length === 0 && (
            <p className="px-2 py-6 text-label text-muted-foreground">{t(($) => $.review.changes.empty)}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {list.map((mr) => (
              <ChangeRow key={mr.id} kbSlug={kbSlug} mr={mr} selected={mr.number === selected} />
            ))}
          </ul>
        </aside>
        {selected > 0 && <ChangeDetail key={selected} kbSlug={kbSlug} number={selected} />}
      </div>
    </div>
  );
}
