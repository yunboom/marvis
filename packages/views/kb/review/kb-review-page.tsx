"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbMergeRequestListOptions } from "@marvis/core/kb/queries";
import type { KbMergeRequest, KbMergeRequestListStatus } from "@marvis/core/types";
import { Tabs, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbStateDot, type KbDot } from "../components/kb-diff";
import { KbReviewDetail, useKbSourceLabel } from "./kb-review-detail";
import { parseKbReviewRoute } from "./kb-review-route";

type Tab = "open" | "ended" | "all";

const TABS: readonly Tab[] = ["open", "ended", "all"];

const TAB_STATUS: Record<Tab, KbMergeRequestListStatus> = { open: "open", ended: "merged,closed", all: "all" };

const STATUS_DOT: Record<KbMergeRequest["status"], KbDot> = { open: "blue", merged: "green", closed: "gray" };

function ReviewRow({ kbSlug, mr, selected }: { kbSlug: string; mr: KbMergeRequest; selected: boolean }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const source = useKbSourceLabel()(mr.source);

  return (
    <li>
      <AppLink
        href={p.kbMergeRequest(kbSlug, mr.number)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex flex-col gap-1 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-surface-hover",
          selected && "bg-surface-selected hover:bg-surface-selected",
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-caption text-faint-foreground">#{mr.number}</span>
          <span className="min-w-0 flex-1 truncate text-label font-medium">{mr.title}</span>
        </span>
        <span className="flex items-center gap-2 text-caption text-faint-foreground">
          <span className="min-w-0 truncate">{source}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <KbStateDot dot={STATUS_DOT[mr.status]} />
            {t(($) => $.review.status[mr.status])}
          </span>
        </span>
      </AppLink>
    </li>
  );
}

/**
 * Review of a knowledge base (designs 8.1–8.8): the merge requests on the
 * left (open, ended, all), the selected one on the right. Without a number
 * in the route the first listed request is shown.
 */
export function KbReviewPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const { kbSlug, number } = parseKbReviewRoute(pathname);
  const [tab, setTab] = useState<Tab>("open");
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: openList = [] } = useQuery(kbMergeRequestListOptions(wsId, kbSlug, "open"));
  const { data: list = [], isLoading } = useQuery(kbMergeRequestListOptions(wsId, kbSlug, TAB_STATUS[tab]));

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
            {t(($) => $.review.title)}
          </span>
        </nav>
      </PageHeader>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside
          aria-label={t(($) => $.review.list_label)}
          className="flex w-[330px] shrink-0 flex-col border-r bg-surface-sunken/30 max-md:max-h-[40%] max-md:w-full max-md:border-r-0 max-md:border-b"
        >
          <div className="px-3.5 pt-3 pb-2">
            <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
              <TabsList>
                {TABS.map((value) => (
                  <TabsTrigger key={value} value={value}>
                    {t(($) => $.review.tabs[value])}
                    {value === "open" && openList.length > 0 && <span className="ml-1 tabular-nums">{openList.length}</span>}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {!isLoading && list.length === 0 && (
            <p className="px-4 py-6 text-label text-muted-foreground">{t(($) => $.review.empty[tab])}</p>
          )}
          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
            {list.map((mr) => (
              <ReviewRow key={mr.id} kbSlug={kbSlug} mr={mr} selected={mr.number === selected} />
            ))}
          </ul>
        </aside>
        {selected > 0 ? (
          <KbReviewDetail key={selected} kbSlug={kbSlug} number={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
            {isLoading ? null : t(($) => $.review.select)}
          </div>
        )}
      </div>
    </div>
  );
}
