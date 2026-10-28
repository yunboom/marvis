"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseListOptions, kbSearchOptions } from "@marvis/core/kb/queries";
import { getShortcut, isPortalLayerShortcutTarget, shortcutMatchesEvent } from "@marvis/core/shortcuts";
import type { KbSearchHit, KbSearchResult } from "@marvis/core/types";
import { isImeComposing } from "@marvis/core/utils";
import { Dialog, DialogContent, DialogTitle } from "@marvis/ui/components/ui/dialog";
import { Input } from "@marvis/ui/components/ui/input";
import { cn } from "@marvis/ui/lib/utils";
import { COLLECTION_SEARCH_ICON, COLLECTION_SEARCH_INPUT } from "../../layout/collection-page";
import { AppLink, useNavigation } from "../../navigation";
import { useDebouncedValue } from "../../common/use-debounced-value";
import { useT } from "../../i18n";

/** Shortcut action that opens the search across every knowledge base. */
const SEARCH_SHORTCUT = "searchKnowledgeBases";

/** Typing pause before a search runs. */
const SEARCH_DEBOUNCE_MS = 250;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The excerpt with every query term in bold, case-insensitive. */
export function highlightTerms(text: string, query: string): ReactNode[] {
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0 || !text) return [text];

  const pattern = new RegExp(`(${terms.join("|")})`, "gi");
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <b key={index} className="font-semibold text-foreground">
        {part}
      </b>
    ) : (
      part
    ),
  );
}

function hitHref(kbPage: (slug: string, pageId: string) => string, hit: KbSearchHit): string {
  const href = kbPage(hit.slug, hit.page_id);
  return hit.block_id ? `${href}#${hit.block_id}` : href;
}

/**
 * Search box of a knowledge base (design 6.1, 6.2): hits open in a panel
 * under the box, each linking to its page at the matching block.
 */
export function KbSearchBox({ kbSlug }: { kbSlug: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const navigation = useNavigation();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const query = useDebouncedValue(value.trim(), SEARCH_DEBOUNCE_MS);
  const { data, isError, isFetching } = useQuery({
    ...kbSearchOptions(wsId, query, { kb: kbSlug }),
    placeholderData: keepPreviousData,
  });

  const showPanel = open && query !== "" && (data !== undefined || isError);
  const hits = data?.hits ?? [];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    const first = hits[0];
    if (event.key === "Enter" && first && !isFetching) {
      event.preventDefault();
      setOpen(false);
      navigation.push(hitHref(p.kbPage, first));
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative w-[220px] shrink-0 transition-[width] focus-within:w-[300px]"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search aria-hidden="true" className={COLLECTION_SEARCH_ICON} />
      <Input
        type="search"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label={t(($) => $.search.placeholder)}
        aria-controls={showPanel ? panelId : undefined}
        aria-expanded={showPanel}
        placeholder={t(($) => $.search.placeholder)}
        className={cn(COLLECTION_SEARCH_INPUT, "w-full")}
      />
      {showPanel && (
        <div
          id={panelId}
          role="region"
          aria-label={t(($) => $.search.placeholder)}
          className="absolute top-[calc(100%+8px)] right-0 z-50 w-[460px] max-w-[calc(100vw-32px)] rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <KbSearchResults query={query} data={data} isError={isError} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

interface KbSearchResultsProps {
  query: string;
  data: KbSearchResult | undefined;
  isError: boolean;
  onPick: () => void;
  /** Names of the knowledge bases by slug; each hit then names its base. */
  baseNames?: ReadonlyMap<string, string>;
}

/** The hits of one search: a count and links to the matching blocks. */
function KbSearchResults({ query, data, isError, onPick, baseNames }: KbSearchResultsProps) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const hits = data?.hits ?? [];

  if (isError && !data) {
    return <p className="px-2.5 py-2 text-label text-muted-foreground">{t(($) => $.search.failed)}</p>;
  }

  if (hits.length === 0) {
    return (
      <div className="flex flex-col gap-2.5 p-2.5">
        <p className="font-medium break-words">{t(($) => $.search.no_results, { query })}</p>
        <p className="text-label text-muted-foreground">{t(($) => $.search.no_results_hint)}</p>
      </div>
    );
  }

  return (
    <>
      <p className="px-2.5 pt-1 pb-1.5 text-caption text-faint-foreground">
        {t(($) => $.search.pages, { count: data?.total ?? hits.length })}
      </p>
      <ul className="flex max-h-[min(60vh,520px)] flex-col overflow-y-auto">
        {hits.map((hit) => {
          const trail = baseNames ? [baseNames.get(hit.slug) ?? hit.slug, ...hit.parents] : hit.parents;

          return (
            <li key={hit.page_id}>
              <AppLink
                href={hitHref(p.kbPage, hit)}
                onClick={onPick}
                className="flex flex-col gap-[3px] rounded-tile p-2.5 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-medium">{hit.title}</span>
                  {trail.length > 0 && (
                    <span className="min-w-0 truncate text-caption text-faint-foreground">{trail.join(" / ")}</span>
                  )}
                </span>
                {hit.excerpt && (
                  <span className="line-clamp-2 text-label leading-relaxed text-muted-foreground">
                    {highlightTerms(hit.excerpt, query)}
                  </span>
                )}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Search across every knowledge base of the workspace, opened from anywhere
 * in a knowledge base with the searchKnowledgeBases shortcut (Mod+Shift+F).
 */
export function KbGlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isImeComposing(event)) return;
      // The binding is read at press time, so a change in Settings applies at once.
      if (!shortcutMatchesEvent(getShortcut(SEARCH_SHORTCUT), event)) return;
      if (isPortalLayerShortcutTarget(event.target)) return;

      event.preventDefault();
      setOpen(true);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <KbGlobalSearchContent onClose={() => setOpen(false)} />}
    </Dialog>
  );
}

function KbGlobalSearchContent({ onClose }: { onClose: () => void }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const navigation = useNavigation();
  const [value, setValue] = useState("");
  const query = useDebouncedValue(value.trim(), SEARCH_DEBOUNCE_MS);
  const { data, isError, isFetching } = useQuery({
    ...kbSearchOptions(wsId, query),
    placeholderData: keepPreviousData,
  });
  const { data: bases = [] } = useQuery(kbBaseListOptions(wsId));
  const baseNames = useMemo(() => new Map(bases.map((base) => [base.slug, base.name])), [bases]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const first = data?.hits[0];
    if (event.key !== "Enter" || !first || isFetching || query === "") return;

    event.preventDefault();
    onClose();
    navigation.push(hitHref(p.kbPage, first));
  };

  return (
    <DialogContent
      showCloseButton={false}
      className="top-[20%] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl!"
    >
      <DialogTitle className="sr-only">{t(($) => $.search.all_placeholder)}</DialogTitle>
      <div className="relative border-b p-2">
        <Search aria-hidden="true" className="absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t(($) => $.search.all_placeholder)}
          placeholder={t(($) => $.search.all_placeholder)}
          className="h-10 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0"
        />
      </div>
      {query !== "" && (data !== undefined || isError) && (
        <div className="p-2">
          <KbSearchResults query={query} data={data} isError={isError} onPick={onClose} baseNames={baseNames} />
        </div>
      )}
    </DialogContent>
  );
}
