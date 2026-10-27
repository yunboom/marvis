"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import type { KbBlock, KbPage, KbSource } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { RichContent } from "../../rich-content";
import { useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import {
  citeNumbers,
  citeSourceId,
  compareBlocks,
  inlineDiffMarkdown,
  isFootnoteDefinitionBlock,
  prepareBlockMarkdown,
  type KbBlockChange,
} from "../utils/kb-markdown";
import { KB_TAG, KbCiteCard, sourceHref, sourceKind, type KbRawFileActions } from "./kb-cite-card";
import { parseKbRawHref } from "../manage/use-kb-raw-files";
import "./kb.css";

/** A verified entry of the page header: `{by: "human:<user id>", at}`. */
interface Verification {
  by: string;
  at: string;
}

const HUMAN_PREFIX = "human:";

export function pageVerifications(frontmatter: Record<string, unknown>): Verification[] {
  const raw = frontmatter.verified;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { by, at } = entry as Record<string, unknown>;
    return typeof by === "string" ? [{ by, at: typeof at === "string" ? at : "" }] : [];
  });
}

export function pageTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

export function pageTitle(page: KbPage): string {
  const title = page.frontmatter.title;
  return typeof title === "string" && title ? title : page.path;
}

export function formatShortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/** Display name of a verifier: a member for human:<id>, otherwise as written. */
export function useVerifierName() {
  const { getMemberName } = useActorName();
  return useCallback(
    (by: string) => (by.startsWith(HUMAN_PREFIX) ? getMemberName(by.slice(HUMAN_PREFIX.length)) : by),
    [getMemberName],
  );
}

function PageMeta({ page }: { page: KbPage }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const verifierName = useVerifierName();
  const verified = pageVerifications(page.frontmatter).at(-1);
  const time = page.last_mr?.merged_at || page.updated_at;

  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-2 text-label text-muted-foreground">
      {page.last_mr ? (
        <>
          <ActorAvatar
            actorType={page.last_mr.author_type}
            actorId={page.last_mr.author_id}
            name={page.last_mr.author_name || undefined}
            size="xs"
          />
          <span>{t(($) => $.page.updated_by, { name: page.last_mr.author_name, time: timeAgo(time) })}</span>
        </>
      ) : (
        time && <span>{t(($) => $.page.updated, { time: timeAgo(time) })}</span>
      )}
      {page.stale ? (
        <span className={cn(KB_TAG, "gap-1.5 bg-warning/12 text-warning")}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {t(($) => $.page.stale)}
        </span>
      ) : (
        verified && (
          <span className={cn(KB_TAG, "gap-1.5")}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            {t(($) => $.page.verified, { name: verifierName(verified.by), date: formatShortDate(verified.at) })}
          </span>
        )
      )}
      {pageTags(page.frontmatter).map((tag) => (
        <span key={tag} className={KB_TAG}>
          {tag}
        </span>
      ))}
    </div>
  );
}

interface HoveredCite {
  source: KbSource;
  top: number;
  left: number;
}

const CARD_WIDTH = 340;

interface BlockViewProps {
  change: KbBlockChange;
  numbers: ReadonlyMap<string, number>;
  highlights: readonly string[];
}

const NO_QUOTES: readonly string[] = [];

function BlockView({ change, numbers, highlights }: BlockViewProps) {
  const { t } = useT("kb");
  const prepare = (block: KbBlock) =>
    prepareBlockMarkdown(block.content, { citeNumbers: numbers, highlights: highlights });

  if (change.kind === "changed") {
    const inline = inlineDiffMarkdown(change.previous.content, change.block.content);
    if (inline !== null) {
      return (
        <div data-block-id={change.block.id} data-change="changed" className="kb-block">
          <RichContent content={prepare({ ...change.block, content: inline })} density="document" phase="settled" />
        </div>
      );
    }
    return (
      <div data-block-id={change.block.id} data-change="changed" className="kb-block">
        <div aria-label={t(($) => $.draft.removed)} className="kb-block-removed">
          <RichContent content={prepare(change.previous)} density="document" phase="settled" />
        </div>
        <div aria-label={t(($) => $.draft.added)} className="kb-block-added">
          <RichContent content={prepare(change.block)} density="document" phase="settled" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-block-id={change.kind === "removed" ? undefined : change.block.id}
      data-change={change.kind}
      aria-label={
        change.kind === "removed" ? t(($) => $.draft.removed) : change.kind === "added" ? t(($) => $.draft.added) : undefined
      }
      className={cn(
        "kb-block",
        change.kind === "removed" && "kb-block-removed",
        change.kind === "added" && "kb-block-added",
      )}
    >
      <RichContent content={prepare(change.block)} density="document" phase="settled" />
    </div>
  );
}

interface KbPageBodyProps {
  page: KbPage;
  /** The published page, when `page` is a draft copy; edits show inline. */
  published?: KbPage | null;
  /** Banners shown under the meta row. */
  banners?: ReactNode;
  rawFileActions?: KbRawFileActions;
  /** Opens a raw:// link of the body, which the server routes to the file's content path. */
  onRawLink?: (id: string, page: number) => void;
  /** Annotated sentences to mark, by block id. */
  annotatedQuotes?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The body of a knowledge base page: title, meta, blocks, sources. Footnotes
 * become numbered citations with a hover card; a draft copy is compared with
 * the published page block by block.
 */
export function KbPageBody({ page, published, banners, rawFileActions, onRawLink, annotatedQuotes }: KbPageBodyProps) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const container = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState<HoveredCite | null>(null);

  const numbers = useMemo(() => citeNumbers(page.sources.map((s) => s.id)), [page.sources]);
  const sourcesById = useMemo(() => new Map(page.sources.map((s) => [s.id, s])), [page.sources]);
  const highlights = useMemo(() => (page.stale ? page.claims.map((c) => c.text) : []), [page.stale, page.claims]);
  const changes = useMemo(() => {
    const blocks = page.blocks.filter((b) => !isFootnoteDefinitionBlock(b.content));
    if (!published || !page.draft_change) return blocks.map((block): KbBlockChange => ({ kind: "same", block }));
    const before = published.blocks.filter((b) => !isFootnoteDefinitionBlock(b.content));
    return compareBlocks(before, blocks);
  }, [page.blocks, page.draft_change, published]);

  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHovered(null), 150);
  };

  const showCite = (anchor: HTMLAnchorElement) => {
    const id = citeSourceId(anchor.getAttribute("href"));
    const source = id ? sourcesById.get(id) : undefined;
    const root = container.current;
    if (!source || !root) return;

    cancelHide();
    const box = root.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(0, Math.min(rect.left - box.left, box.width - CARD_WIDTH));
    setHovered({ source, top: rect.bottom - box.top + 6, left });
  };

  const anchorOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLAnchorElement>("a[href^='#kb-']") : null;

  const openSource = (source: KbSource) => {
    if (source.raw && rawFileActions) {
      rawFileActions.open(source.raw);
      return;
    }
    const href = sourceHref(source, p);
    if (href) push(href);
    else if (sourceKind(source.kind) === "web" && source.openable) window.open(source.uri, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      ref={container}
      className="kb-doc relative"
      // Citation and unwritten-page links are handled here, before the
      // Markdown link handler would treat them as navigation.
      onClickCapture={(e) => {
        const rawLink = onRawLink && e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
        const raw = rawLink ? parseKbRawHref(rawLink.getAttribute("href")) : null;
        if (raw && onRawLink) {
          e.preventDefault();
          e.stopPropagation();
          onRawLink(raw.id, raw.page);
          return;
        }
        const anchor = anchorOf(e.target);
        if (!anchor) return;
        e.preventDefault();
        e.stopPropagation();
        const id = citeSourceId(anchor.getAttribute("href"));
        const source = id ? sourcesById.get(id) : undefined;
        if (source) openSource(source);
      }}
      onMouseOver={(e) => {
        const anchor = anchorOf(e.target);
        if (anchor && citeSourceId(anchor.getAttribute("href"))) showCite(anchor);
      }}
      onMouseOut={(e) => {
        if (anchorOf(e.target)) scheduleHide();
      }}
      onFocus={(e) => {
        const anchor = anchorOf(e.target);
        if (anchor && citeSourceId(anchor.getAttribute("href"))) showCite(anchor);
      }}
      onBlur={scheduleHide}
    >
      <h1 className="mb-2 text-display-sm font-semibold">{pageTitle(page)}</h1>
      <PageMeta page={page} />

      {banners}

      <div className="flex flex-col">
        {changes.map((change, i) => (
          <BlockView
            key={`${change.kind}-${change.block.id}-${i}`}
            change={change}
            numbers={numbers}
            highlights={blockHighlights(highlights, annotatedQuotes?.get(change.block.id) ?? NO_QUOTES)}
          />
        ))}
      </div>

      {page.sources.length > 0 && (
        <section className="mt-6 flex flex-col gap-1 border-t pt-3.5 text-label text-muted-foreground">
          <h2 className="text-faint-foreground">{t(($) => $.page.sources)}</h2>
          {page.sources.map((source) => (
            <button
              key={source.id}
              type="button"
              id={`kb-source-${source.id}`}
              onClick={() => openSource(source)}
              className="text-left hover:text-foreground"
            >
              [{numbers.get(source.id)}] {t(($) => $.cite.kind[sourceKind(source.kind)])} ·{" "}
              {sourceKind(source.kind) === "chat" && !source.openable
                ? t(($) => $.cite.chat_private)
                : source.raw?.name || source.title || source.uri}
            </button>
          ))}
        </section>
      )}

      {hovered && (
        <div
          role="dialog"
          aria-label={hovered.source.title || hovered.source.uri}
          className="absolute z-20 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg"
          style={{ top: hovered.top, left: hovered.left, width: CARD_WIDTH }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <KbCiteCard source={hovered.source} rawFileActions={rawFileActions} />
        </div>
      )}
    </div>
  );
}

function blockHighlights(claims: readonly string[], quotes: readonly string[]): readonly string[] {
  if (quotes.length === 0) return claims;
  return [...claims, ...quotes];
}
