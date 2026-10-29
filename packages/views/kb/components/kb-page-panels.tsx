"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbPageHistoryOptions } from "@marvis/core/kb/queries";
import type { KbPage, KbRevision, KbSource } from "@marvis/core/types";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { pageHeadings } from "../utils/kb-markdown";
import { KB_TAG, sourceKind } from "./kb-cite-card";
import { formatShortDate, pageTags, pageVerifications, useVerifierName } from "./kb-page-body";
import { withDraft } from "./kb-page-tree";

export function KbPanel({
  title,
  actions,
  onClose,
  children,
  className,
}: {
  title: string;
  /** Controls shown in the header, before the close button. */
  actions?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT("kb");

  return (
    <aside aria-label={title} className={cn("flex w-[300px] shrink-0 flex-col border-l bg-background", className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-body font-medium">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {actions}
        {onClose && (
          <button
            type="button"
            aria-label={t(($) => $.page.close_panel)}
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-caption text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function sourceSubtitle(source: KbSource): string {
  if (sourceKind(source.kind) === "repo" && source.version) return source.version;
  return "";
}

export function KbInfoPanel({
  page,
  kbSlug,
  draft = "",
  diff = true,
  onClose,
  onOpenSource,
}: {
  page: KbPage;
  kbSlug: string;
  /** The draft being read; page links keep it. */
  draft?: string;
  /** The draft's edits are marked; page links keep that too. */
  diff?: boolean;
  onClose: () => void;
  onOpenSource: (source: KbSource) => void;
}) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const verifierName = useVerifierName();
  const verifications = pageVerifications(page.frontmatter);
  const tags = pageTags(page.frontmatter);
  const staleAfter = typeof page.frontmatter.stale_after === "string" ? page.frontmatter.stale_after : "";

  return (
    <KbPanel title={t(($) => $.page.info)} onClose={onClose}>
      <Section title={t(($) => $.info.verified)}>
        <div className="flex flex-col gap-1 text-label">
          {verifications.length === 0 && <span className="text-muted-foreground">{t(($) => $.info.none)}</span>}
          {verifications.map((v) => (
            <span key={`${v.by}-${v.at}`} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              {t(($) => $.info.verified_by, { name: verifierName(v.by), date: formatShortDate(v.at) })}
            </span>
          ))}
          {staleAfter && (
            <span className={page.stale ? "text-warning" : "text-muted-foreground"}>
              {t(($) => $.info.next_review, { date: formatShortDate(staleAfter) })}
            </span>
          )}
        </div>
      </Section>
      {tags.length > 0 && (
        <Section title={t(($) => $.info.tags)}>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className={KB_TAG}>
                {tag}
              </span>
            ))}
          </div>
        </Section>
      )}
      <Section title={t(($) => $.info.sources, { count: page.sources.length })}>
        <div className="flex flex-col gap-1.5">
          {page.sources.map((source) => {
            const kind = sourceKind(source.kind);
            const subtitle = sourceSubtitle(source);
            const privateChat = kind === "chat" && !source.openable;
            return (
              <button
                key={source.id}
                type="button"
                disabled={privateChat}
                onClick={() => onOpenSource(source)}
                className="flex flex-col rounded-lg border px-2.5 py-2 text-left text-label hover:bg-surface-hover disabled:hover:bg-transparent"
              >
                <span className="text-caption text-faint-foreground">
                  {t(($) => $.cite.kind[kind])}
                  {subtitle && ` · ${subtitle}`}
                </span>
                <span className={cn("min-w-0 truncate", kind === "repo" && "font-mono", privateChat && "text-muted-foreground")}>
                  {privateChat ? t(($) => $.cite.chat_private) : source.raw?.name || source.title || source.uri}
                </span>
              </button>
            );
          })}
          {page.sources.length === 0 && <span className="text-label text-muted-foreground">{t(($) => $.info.none)}</span>}
        </div>
      </Section>
      <Section title={t(($) => $.info.backlinks)}>
        <div className="flex flex-col gap-1 text-label">
          {page.backlinks.map((link) => (
            <AppLink key={link.id} href={withDraft(p.kbPage(kbSlug, link.id), draft, diff)} className="text-info hover:underline">
              {link.title}
            </AppLink>
          ))}
          {page.backlinks.length === 0 && <span className="text-muted-foreground">{t(($) => $.info.none)}</span>}
        </div>
      </Section>
    </KbPanel>
  );
}

export function KbTocPanel({
  page,
  activeBlockId,
  onJump,
  onClose,
}: {
  page: KbPage;
  activeBlockId: string;
  onJump: (blockId: string) => void;
  onClose: () => void;
}) {
  const { t } = useT("kb");
  const headings = pageHeadings(page.blocks);
  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <KbPanel title={t(($) => $.page.toc)} onClose={onClose} className="w-[240px]">
      <nav className="flex flex-col gap-0.5 text-body-lg">
        {headings.length === 0 && <span className="text-label text-muted-foreground">{t(($) => $.toc.empty)}</span>}
        {headings.map((heading) => (
          <button
            key={heading.blockId}
            type="button"
            aria-current={heading.blockId === activeBlockId ? "location" : undefined}
            onClick={() => onJump(heading.blockId)}
            className={cn(
              "rounded-lg px-2 py-1.5 text-left text-foreground hover:bg-surface-hover",
              heading.blockId === activeBlockId && "bg-surface-selected text-foreground",
            )}
            style={{ paddingLeft: 8 + (heading.level - minLevel) * 12 }}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </KbPanel>
  );
}

function revisionTitle(revision: KbRevision, initial: string): string {
  return revision.mr_number === null ? initial : revision.mr_title;
}

/** A page's history; each entry opens that revision's diff. */
export function KbHistoryList({
  kbSlug,
  pageId,
  selectedRevisionId,
}: {
  kbSlug: string;
  pageId: string;
  selectedRevisionId?: string;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const { data: revisions = [], isLoading } = useQuery(kbPageHistoryOptions(wsId, pageId));

  if (!isLoading && revisions.length === 0) {
    return <span className="text-label text-muted-foreground">{t(($) => $.history.empty)}</span>;
  }

  return (
    <ol className="-m-1.5 flex flex-col gap-1">
      {isLoading &&
        Array.from({ length: 4 }).map((_, i) => (
          <li key={i} aria-hidden="true" className="flex flex-col gap-2 p-2.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </li>
        ))}
      {revisions.map((revision) => (
        <li key={revision.revision_id}>
          <AppLink
            href={p.kbRevision(kbSlug, pageId, revision.revision_id)}
            aria-current={revision.revision_id === selectedRevisionId ? "page" : undefined}
            className={cn(
              "flex flex-col gap-[3px] rounded-tile p-2.5 hover:bg-surface-hover",
              revision.revision_id === selectedRevisionId && "bg-surface-selected hover:bg-surface-selected",
            )}
          >
            <span className="flex items-center gap-1.5">
              {revision.mr_number !== null && (
                <span className="font-mono text-caption text-faint-foreground">#{revision.mr_number}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-body font-medium">
                {revisionTitle(revision, t(($) => $.history.initial))}
              </span>
            </span>
            <span className="text-caption text-faint-foreground">
              {revision.mr_number === null
                ? timeAgo(revision.merged_at)
                : t(($) => $.history.meta, {
                    author: revision.author_name,
                    merger: revision.merged_by_name,
                    time: timeAgo(revision.merged_at),
                  })}
            </span>
            {revision.current && <span className={cn(KB_TAG, "self-start")}>{t(($) => $.history.current)}</span>}
          </AppLink>
        </li>
      ))}
    </ol>
  );
}

export function KbHistoryPanel({
  kbSlug,
  pageId,
  selectedRevisionId,
  onClose,
}: {
  kbSlug: string;
  pageId: string;
  selectedRevisionId?: string;
  onClose?: () => void;
}) {
  const { t } = useT("kb");

  return (
    <KbPanel title={t(($) => $.page.history)} onClose={onClose}>
      <KbHistoryList kbSlug={kbSlug} pageId={pageId} selectedRevisionId={selectedRevisionId} />
    </KbPanel>
  );
}
