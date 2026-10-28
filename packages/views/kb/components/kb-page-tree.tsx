"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbTreeLevelOptions } from "@marvis/core/kb/queries";
import type { KbTreePage } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { KbNewPagePopover } from "../jobs/kb-new-page-popover";

const DRAFT_CHANGES = ["added", "modified", "moved", "deleted"] as const;
type DraftChange = (typeof DRAFT_CHANGES)[number];

function isDraftChange(value: string): value is DraftChange {
  return (DRAFT_CHANGES as readonly string[]).includes(value);
}

const DRAFT_DELETED: DraftChange = "deleted";

// A draft read marks the draft's edits on the page and in the tree unless
// ?diff=0 turns them off; ?diff=1 and the older ?view=diff read as on.
const DIFF_PARAM = "diff";
const DIFF_OFF = "0";

/** Whether a draft read marks the draft's edits. */
export function readsDraftDiff(searchParams: URLSearchParams): boolean {
  return !!searchParams.get("draft") && searchParams.get(DIFF_PARAM) !== DIFF_OFF;
}

/**
 * Appends ?draft=<id> so the tree and page stay on the draft being viewed,
 * and &diff=0 while its edits are not marked.
 */
export function withDraft(href: string, draft: string, diff = true): string {
  if (!draft) return href;
  const read = `${href}?draft=${encodeURIComponent(draft)}`;

  return diff ? read : `${read}&${DIFF_PARAM}=${DIFF_OFF}`;
}

interface TreeContext {
  kbSlug: string;
  draft: string;
  /** The draft's edits are marked: deleted pages stay, struck through, and rows carry their change. */
  diff: boolean;
  selectedId: string;
  expansion: TreeExpansion;
  toggle: (id: string, depth: number) => void;
}

/**
 * Which rows of the tree are open. Top-level rows start open; `collapsed`
 * remembers the ones the reader closed, `expanded` the deeper ones opened.
 */
export interface TreeExpansion {
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
}

/** Whether a row at `depth` shows its children. */
export function isTreeRowOpen(expansion: TreeExpansion, id: string, depth: number): boolean {
  if (expansion.expanded.has(id)) return true;

  return depth === 0 && !expansion.collapsed.has(id);
}

/** Opens a closed row or closes an open one. */
export function toggleTreeRow(expansion: TreeExpansion, id: string, depth: number): TreeExpansion {
  const expanded = new Set(expansion.expanded);
  const collapsed = new Set(expansion.collapsed);

  if (isTreeRowOpen(expansion, id, depth)) {
    expanded.delete(id);
    collapsed.add(id);
  } else {
    expanded.add(id);
    collapsed.delete(id);
  }

  return { expanded, collapsed };
}

/** Opens every row in `ids`, e.g. the ancestors of the page being read. */
export function expandTreeRows(expansion: TreeExpansion, ids: readonly string[]): TreeExpansion {
  const missing = ids.filter((id) => !expansion.expanded.has(id) || expansion.collapsed.has(id));
  if (missing.length === 0) return expansion;

  const collapsed = new Set(expansion.collapsed);
  for (const id of missing) collapsed.delete(id);

  return { expanded: new Set([...expansion.expanded, ...missing]), collapsed };
}

function DraftTag({ change }: { change: DraftChange }) {
  const { t } = useT("kb");

  return (
    <span className="shrink-0 rounded-md px-1.5 text-caption leading-[17px] text-status-review ring-1 ring-status-review/50 ring-inset">
      {t(($) => $.tree.draft[change])}
    </span>
  );
}

function TreeRow({ page, depth, ctx }: { page: KbTreePage; depth: number; ctx: TreeContext }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const open = isTreeRowOpen(ctx.expansion, page.id, depth);
  const selected = page.id === ctx.selectedId;
  const change = ctx.diff && isDraftChange(page.draft_change) ? page.draft_change : null;

  return (
    <li>
      <div
        className={cn(
          "group/tree flex h-8 items-center gap-1 rounded-lg pr-1.5 text-body text-foreground transition-colors hover:bg-surface-hover",
          selected && "bg-surface-selected font-medium text-foreground hover:bg-surface-selected",
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        {page.has_child ? (
          <button
            type="button"
            aria-label={t(($) => (open ? $.tree.collapse : $.tree.expand), { title: page.title })}
            aria-expanded={open}
            onClick={() => ctx.toggle(page.id, depth)}
            className="flex size-4 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <AppLink
          href={withDraft(p.kbPage(ctx.kbSlug, page.id), ctx.draft, ctx.diff)}
          aria-current={selected ? "page" : undefined}
          title={page.description || page.title}
          className={cn(
            "min-w-0 flex-1 truncate outline-none",
            change === DRAFT_DELETED && "text-muted-foreground line-through",
          )}
        >
          {page.title || page.path}
        </AppLink>
        {page.stale && (
          <span
            role="img"
            aria-label={t(($) => $.tree.stale)}
            title={t(($) => $.tree.stale)}
            className="mr-1 size-1.5 shrink-0 rounded-full bg-warning"
          />
        )}
        {change && <DraftTag change={change} />}
        {!ctx.draft && <KbNewPagePopover kbSlug={ctx.kbSlug} parentId={page.id} parentTitle={page.title || page.path} />}
      </div>
      {open && page.has_child && <TreeLevel parentId={page.id} depth={depth + 1} ctx={ctx} />}
    </li>
  );
}

function TreeLevel({ parentId, depth, ctx }: { parentId: string; depth: number; ctx: TreeContext }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery(
    kbTreeLevelOptions(wsId, ctx.kbSlug, parentId, ctx.draft),
  );
  const sentinel = useRef<HTMLButtonElement>(null);

  // A level longer than one cursor page loads the rest as it scrolls into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Without the edits marked, the tree is the knowledge base as the draft
  // would leave it.
  const pages = (data?.pages.flatMap((level) => level.pages) ?? []).filter(
    (page) => ctx.diff || page.draft_change !== DRAFT_DELETED,
  );

  if (isLoading) {
    return (
      <div className="h-8 animate-pulse rounded-lg bg-surface-sunken/60" style={{ marginLeft: 6 + depth * 16 }} />
    );
  }

  if (depth === 0 && pages.length === 0) {
    return <p className="px-2 py-1.5 text-label text-faint-foreground">{t(($) => $.tree.empty)}</p>;
  }

  return (
    <ul role={depth === 0 ? "tree" : "group"} className="flex flex-col gap-px">
      {pages.map((page) => (
        <TreeRow key={page.id} page={page} depth={depth} ctx={ctx} />
      ))}
      {hasNextPage && (
        <li>
          <button
            ref={sentinel}
            type="button"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            className="h-7 rounded-lg text-label text-muted-foreground hover:text-foreground"
            style={{ paddingLeft: 26 + depth * 16 }}
          >
            {t(($) => $.tree.load_more)}
          </button>
        </li>
      )}
    </ul>
  );
}

interface KbPageTreeProps {
  kbSlug: string;
  /** The page being read; its row is highlighted. */
  selectedId: string;
  /** Ancestors of the page being read; they are expanded on arrival. */
  ancestorIds: readonly string[];
  /** Draft whose changes the tree shows; empty for the mainline. */
  draft: string;
  /** The draft's edits are marked. */
  diff?: boolean;
}

/**
 * The page tree of one knowledge base. Each level is fetched when it is first
 * shown; top-level pages start expanded, and opening a page expands its
 * ancestors so their levels load together.
 */
export function KbPageTree({ kbSlug, selectedId, ancestorIds, draft, diff = true }: KbPageTreeProps) {
  const [expansion, setExpansion] = useState<TreeExpansion>(() => ({
    expanded: new Set(ancestorIds),
    collapsed: new Set<string>(),
  }));

  const ancestorKey = ancestorIds.join("/");
  useEffect(() => {
    if (!ancestorKey) return;
    setExpansion((prev) => expandTreeRows(prev, ancestorKey.split("/")));
  }, [ancestorKey]);

  const toggle = useCallback((id: string, depth: number) => {
    setExpansion((prev) => toggleTreeRow(prev, id, depth));
  }, []);

  return <TreeLevel parentId="" depth={0} ctx={{ kbSlug, draft, diff, selectedId, expansion, toggle }} />;
}
