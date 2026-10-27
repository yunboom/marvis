"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Link2, MoreHorizontal, Plus, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentWorkspace, useWorkspacePaths } from "@marvis/core/paths";
import { countOpenMergeRequests, kbBaseListOptions } from "@marvis/core/kb/queries";
import type { KnowledgeBase } from "@marvis/core/types";
import { Button, buttonVariants } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import {
  ListGrid,
  ListGridCell,
  ListGridHeader,
  ListGridHeaderCell,
  ListGridRow,
  LIST_GRID_BOTTOM_CLEARANCE,
} from "@marvis/ui/components/ui/list-grid";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { DeferredTooltip } from "@marvis/ui/components/common/deferred-tooltip";
import { copyText } from "@marvis/ui/lib/clipboard";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink, useNavigation, useRowLink } from "../../navigation";
import {
  COLLECTION_ROW,
  COLLECTION_ROW_TALL,
  COLLECTION_SEARCH_ICON,
  COLLECTION_SEARCH_INPUT,
  COLLECTION_TABLE_INSET,
  COLLECTION_TOOLBAR_BUTTON,
  COLLECTION_TOOLBAR_BUTTON_IDLE,
  CollectionPageHeader,
  CollectionPageState,
} from "../../layout/collection-page";
import { PAGE_TOOLBAR } from "../../layout/page-header";
import { ROUTE_ICON_COMPONENTS } from "../../layout/route-icon-components";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useLocale, useT, useTimeAgo } from "../../i18n";

const KbIcon = ROUTE_ICON_COMPONENTS.Layers;

// Column template. Narrow (<@2xl): name, pages, updated, kebab. Wide adds
// description and pending work. Hidden cells drop out of the grid flow, so
// each template only lists the tracks of the cells it shows.
const GRID_COLS =
  "grid-cols-[0.75rem_minmax(140px,1fr)_3.5rem_6rem_1.75rem_0.75rem] " +
  "@2xl:grid-cols-[0.75rem_minmax(180px,2.2fr)_minmax(0,3fr)_minmax(3.5rem,0.8fr)_minmax(8rem,1.2fr)_minmax(6rem,1fr)_1.75rem_0.75rem]";

const LIST_HEAD = "h-10 rounded-lg bg-surface-sunken [&_[role=columnheader]]:text-label";

const KB_TAG =
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface px-2.5 text-caption text-foreground";

const KB_SORTS = ["recent", "name"] as const;
type KbSort = (typeof KB_SORTS)[number];

function sortBases(bases: readonly KnowledgeBase[], sort: KbSort, locale: string): KnowledgeBase[] {
  const sorted = [...bases];
  if (sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name, locale));
    return sorted;
  }

  sorted.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  return sorted;
}

function matchesSearch(base: KnowledgeBase, query: string): boolean {
  if (!query) return true;

  const q = query.toLowerCase();
  return (
    base.name.toLowerCase().includes(q) ||
    base.slug.toLowerCase().includes(q) ||
    base.description.toLowerCase().includes(q) ||
    matchesPinyin(base.name, q)
  );
}

function KbInitial({ name }: { name: string }) {
  // Array.from keeps a leading emoji or astral character whole.
  const initial = Array.from(name.trim())[0] ?? "";

  return (
    <span
      aria-hidden="true"
      className="flex size-7.5 shrink-0 items-center justify-center rounded-lg bg-identity-gray text-label font-semibold text-identity-gray-foreground"
    >
      {initial.toUpperCase()}
    </span>
  );
}

function PendingCell({ base }: { base: KnowledgeBase }) {
  const { t } = useT("kb");
  const { annotations, stale_pages: stalePages } = base.pending;

  const parts: string[] = [];
  if (annotations > 0) parts.push(t(($) => $.list.pending.annotations, { count: annotations }));
  if (stalePages > 0) parts.push(t(($) => $.list.pending.stale_pages, { count: stalePages }));

  return (
    <ListGridCell className="hidden @2xl:flex">
      {parts.length > 0 ? (
        <span className={KB_TAG}>{parts.join(" · ")}</span>
      ) : (
        <span className="text-label text-faint-foreground">—</span>
      )}
    </ListGridCell>
  );
}

function KbRowActions({ base }: { base: KnowledgeBase }) {
  const { t } = useT("kb");
  const { t: tCommon } = useT("common");
  const p = useWorkspacePaths();
  const { getShareableUrl } = useNavigation();

  const copyLink = () => {
    void copyText(getShareableUrl(p.kbBase(base.slug))).then((ok) => {
      if (ok) toast.success(t(($) => $.list.link_copied));
    });
  };

  return (
    // Keeps menu clicks from reaching the row's navigation handler.
    <span onClick={(e) => e.stopPropagation()} className="flex items-center">
      <DropdownMenu>
        <DeferredTooltip
          content={tCommon(($) => $.more_actions)}
          trigger={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={tCommon(($) => $.more_actions)}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--motion-fast) ease-out hover:bg-surface-selected hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-popup-open:bg-surface-selected data-popup-open:text-foreground data-popup-open:opacity-100"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              }
            />
          }
        />
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={copyLink}>
            <Link2 className="size-3.5" />
            {t(($) => $.list.copy_link)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function KbListHeader() {
  const { t } = useT("kb");

  return (
    <ListGridHeader className={LIST_HEAD}>
      <ListGridHeaderCell>{t(($) => $.list.table.name)}</ListGridHeaderCell>
      <ListGridHeaderCell className="hidden @2xl:flex">
        {t(($) => $.list.table.description)}
      </ListGridHeaderCell>
      <ListGridHeaderCell>{t(($) => $.list.table.pages)}</ListGridHeaderCell>
      <ListGridHeaderCell className="hidden @2xl:flex">
        {t(($) => $.list.table.pending)}
      </ListGridHeaderCell>
      <ListGridHeaderCell>{t(($) => $.list.table.updated)}</ListGridHeaderCell>
      <span aria-hidden="true" />
    </ListGridHeader>
  );
}

function KbRow({ base }: { base: KnowledgeBase }) {
  const p = useWorkspacePaths();
  const rowLink = useRowLink();
  const timeAgo = useTimeAgo();

  return (
    <ListGridRow
      className={cn(COLLECTION_ROW, COLLECTION_ROW_TALL, "cursor-pointer")}
      {...rowLink(p.kbBase(base.slug), base.name)}
    >
      <ListGridCell className="gap-2.5">
        <KbInitial name={base.name} />
        <div className="min-w-0 flex-1">
          <span className="block min-w-0 truncate text-body font-medium">{base.name}</span>
          <span className="mt-0.5 block min-w-0 truncate font-mono text-caption text-faint-foreground">
            {base.slug}/
          </span>
        </div>
      </ListGridCell>
      <ListGridCell className="hidden @2xl:flex">
        <span className="min-w-0 truncate text-label text-muted-foreground">{base.description}</span>
      </ListGridCell>
      <ListGridCell className="text-label tabular-nums">{base.page_count}</ListGridCell>
      <PendingCell base={base} />
      <ListGridCell className="whitespace-nowrap text-label text-muted-foreground">
        {base.updated_at ? timeAgo(base.updated_at) : "—"}
      </ListGridCell>
      <ListGridCell className="justify-end px-0">
        <KbRowActions base={base} />
      </ListGridCell>
    </ListGridRow>
  );
}

function KbListToolbar({
  search,
  onSearchChange,
  sort,
  onSortChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  sort: KbSort;
  onSortChange: (sort: KbSort) => void;
}) {
  const { t } = useT("kb");
  const sortLabels: Record<KbSort, string> = {
    recent: t(($) => $.list.sort.recent),
    name: t(($) => $.list.sort.name),
  };

  return (
    <div className={cn(PAGE_TOOLBAR, "h-14 gap-2.5")}>
      <div className="relative min-w-0">
        <Search className={cn(COLLECTION_SEARCH_ICON, "size-4")} />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label={t(($) => $.list.search_label)}
          placeholder={t(($) => $.list.search_placeholder)}
          className={cn(COLLECTION_SEARCH_INPUT, "h-9 w-70 max-w-full pl-9 text-body")}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(COLLECTION_TOOLBAR_BUTTON, COLLECTION_TOOLBAR_BUTTON_IDLE, "shrink-0")}
            >
              {sort === "name" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
              {sortLabels[sort]}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as KbSort)}>
            {KB_SORTS.map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {sortLabels[key]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// A destination, so a link styled as the primary button rather than a button.
function NewKbLink() {
  const { t } = useT("kb");
  const p = useWorkspacePaths();

  return (
    <AppLink
      href={p.kbNew()}
      className={cn(buttonVariants({ size: "sm" }), "h-9 gap-1.5 pr-4 pl-3.5 text-body")}
    >
      <Plus aria-hidden="true" className="size-4" />
      {t(($) => $.list.new_button)}
    </AppLink>
  );
}

/** Knowledge base list of the current workspace. */
export function KbListPage() {
  const { t } = useT("kb");
  const locale = useLocale();
  const wsId = useCurrentWorkspace()?.id ?? "";
  const { data: bases = [], isLoading } = useQuery(kbBaseListOptions(wsId));
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<KbSort>("recent");

  const openMergeRequests = countOpenMergeRequests(bases);
  const query = search.trim();
  const rows = useMemo(
    () => sortBases(bases.filter((base) => matchesSearch(base, query)), sort, locale),
    [bases, query, sort, locale],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader
        icon={KbIcon}
        title={t(($) => $.list.title)}
        count={bases.length}
        description={
          openMergeRequests > 0 ? (
            <span className={KB_TAG}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
              {t(($) => $.list.pending_reviews, { count: openMergeRequests })}
            </span>
          ) : undefined
        }
        actions={<NewKbLink />}
      />

      {isLoading ? (
        <LoadingSkeleton />
      ) : bases.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <CollectionPageState
            icon={KbIcon}
            title={t(($) => $.list.empty_title)}
            description={t(($) => $.list.empty_description)}
            actions={<NewKbLink />}
          />
        </div>
      ) : (
        <>
          <KbListToolbar search={search} onSearchChange={setSearch} sort={sort} onSortChange={setSort} />
          <div className={cn("min-h-0 flex-1 overflow-auto @container", COLLECTION_TABLE_INSET)}>
            <ListGrid className={GRID_COLS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
              <KbListHeader />
              {rows.length === 0 ? (
                <div className="col-span-full py-16 text-center text-body text-muted-foreground">
                  {t(($) => $.list.no_matches)}
                </div>
              ) : (
                rows.map((base) => <KbRow key={base.id} base={base} />)
              )}
            </ListGrid>
          </div>
        </>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto @container", COLLECTION_TABLE_INSET)}>
      <ListGrid className={GRID_COLS}>
        <ListGridHeader className={LIST_HEAD}>
          <ListGridHeaderCell>
            <Skeleton className="h-3 w-12" />
          </ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            <Skeleton className="h-3 w-12" />
          </ListGridHeaderCell>
          <ListGridHeaderCell>
            <Skeleton className="h-3 w-8" />
          </ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            <Skeleton className="h-3 w-12" />
          </ListGridHeaderCell>
          <ListGridHeaderCell>
            <Skeleton className="h-3 w-12" />
          </ListGridHeaderCell>
          <span aria-hidden="true" />
        </ListGridHeader>
        {Array.from({ length: 4 }).map((_, i) => (
          <ListGridRow key={i} className={cn(COLLECTION_ROW, COLLECTION_ROW_TALL, "hover:bg-transparent")}>
            <ListGridCell className="gap-2.5">
              <Skeleton className="size-7.5 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-28 max-w-full" />
                <Skeleton className="h-3 w-16 max-w-full" />
              </div>
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <Skeleton className="h-3 w-48 max-w-full" />
            </ListGridCell>
            <ListGridCell>
              <Skeleton className="h-3 w-6" />
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <Skeleton className="h-6 w-24 rounded-full" />
            </ListGridCell>
            <ListGridCell>
              <Skeleton className="h-3 w-14" />
            </ListGridCell>
            <span aria-hidden="true" />
          </ListGridRow>
        ))}
      </ListGrid>
    </div>
  );
}
