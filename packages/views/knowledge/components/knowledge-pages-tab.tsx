"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  KNOWLEDGE_DOMAINS,
  KNOWLEDGE_PAGE_GROUPS,
  knowledgePageListOptions,
  knowledgePageOptions,
  type KnowledgeBase,
  type KnowledgePage,
  type KnowledgePageSummary,
  type KnowledgeSource,
} from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@marvis/ui/components/ui/hover-card";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { cn } from "@marvis/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

type DomainFilter = "all" | (typeof KNOWLEDGE_DOMAINS)[number];

export interface KnowledgeReaderSlots {
  /** Extra controls beside the page header (edit, page annotation). */
  headerActions?: (page: KnowledgePage) => ReactNode;
  /** Renders one sentence; defaults to plain text. Annotations replace it. */
  renderSentence?: (page: KnowledgePage, sentence: { text: string; key: string }) => ReactNode;
  /** Content below a section (annotation composer). */
  afterSection?: (page: KnowledgePage, sectionIndex: number) => ReactNode;
  /** Right-hand rail (page annotations). */
  rail?: (page: KnowledgePage) => ReactNode;
  /** Replaces the reader body (manual edit mode). */
  override?: (page: KnowledgePage) => ReactNode | null;
}

export function useSelectedKnowledgePage(): [string | null, (path: string | null) => void] {
  const navigation = useNavigation();
  const selected = new URLSearchParams(navigation.searchParams).get("page");
  const select = (path: string | null) => {
    const next = new URLSearchParams(navigation.searchParams);
    if (path) next.set("page", path);
    else next.delete("page");
    navigation.replace(`${navigation.pathname}${next.size ? `?${next}` : ""}${navigation.hash}`);
  };

  return [selected, select];
}

export function KnowledgePagesTab({ kb, slots = {} }: { kb: KnowledgeBase; slots?: KnowledgeReaderSlots }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const [domain, setDomain] = useState<DomainFilter>("all");
  const [selected, select] = useSelectedKnowledgePage();

  const { data: list, isLoading } = useQuery(knowledgePageListOptions(wsId, kb.id));
  const pages = useMemo(() => list?.pages ?? [], [list]);
  const current = pages.find((p) => p.path === selected) ?? pages[0] ?? null;

  const groups = useMemo(
    () =>
      KNOWLEDGE_PAGE_GROUPS.map((group) => ({
        group,
        pages: pages.filter((p) => p.group === group && (domain === "all" || p.domains.includes(domain))),
      })).filter((g) => g.pages.length > 0),
    [pages, domain],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label={t(($) => $.pages.tree_label)} className="w-64 shrink-0 overflow-y-auto border-r border-border px-2.5 py-3">
        <div role="radiogroup" aria-label={t(($) => $.pages.domain_filter)} className="mb-2 flex flex-wrap gap-1 px-1">
          {(["all", ...KNOWLEDGE_DOMAINS] as const).map((d) => (
            <Button
              key={d}
              role="radio"
              aria-checked={domain === d}
              size="xs"
              variant={domain === d ? "secondary" : "ghost"}
              onClick={() => setDomain(d)}
            >
              {t(($) => $.domains[d])}
            </Button>
          ))}
        </div>
        {isLoading ? (
          <div className="flex flex-col gap-2 px-1">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-caption text-muted-foreground">{t(($) => $.pages.empty)}</p>
        ) : (
          groups.map(({ group, pages: groupPages }) => (
            <div key={group} className="mb-1">
              <div className="px-2 pt-2.5 pb-1 text-caption text-muted-foreground">{t(($) => $.groups[group])}</div>
              {groupPages.map((p) => (
                <PageTreeRow key={p.path} page={p} active={current?.path === p.path} onSelect={() => select(p.path)} />
              ))}
            </div>
          ))
        )}
      </nav>
      {current ? (
        <PageReader kb={kb} path={current.path} slots={slots} onOpen={select} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-10 text-body text-muted-foreground">
          {isLoading ? null : t(($) => $.pages.no_pages)}
        </div>
      )}
    </div>
  );
}

function PageTreeRow({ page, active, onSelect }: { page: KnowledgePageSummary; active: boolean; onSelect: () => void }) {
  const { t } = useT("knowledge");

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-row px-2 text-left text-body transition-colors hover:bg-accent",
        active && "bg-secondary font-medium",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{page.title}</span>
      {page.needs_check || page.agent_findings > 0 ? (
        <span aria-label={t(($) => $.pages.needs_attention)} className="size-1.5 shrink-0 rounded-full bg-status-progress" />
      ) : null}
      {page.open_annotations > 0 ? <span className="text-caption text-muted-foreground">{page.open_annotations}</span> : null}
    </button>
  );
}

function PageReader({
  kb,
  path,
  slots,
  onOpen,
}: {
  kb: KnowledgeBase;
  path: string;
  slots: KnowledgeReaderSlots;
  onOpen: (path: string) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const { data: page, isLoading } = useQuery(knowledgePageOptions(wsId, kb.id, path));

  if (isLoading || !page) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full max-w-2xl" />
      </div>
    );
  }

  const override = slots.override?.(page);
  if (override) return <>{override}</>;

  const sourcesByN = new Map(page.sources.map((s) => [s.n, s]));
  const fm = page.front_matter;

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <article className="min-w-0 flex-1 overflow-y-auto px-10 pt-7 pb-16">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            <span>{t(($) => $.groups[page.group as (typeof KNOWLEDGE_PAGE_GROUPS)[number]], { defaultValue: page.group })}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono">{page.path}</span>
            <div className="flex-1" />
            {slots.headerActions?.(page)}
          </div>
          <h1 className="mt-2 mb-3 text-title-lg font-semibold">{page.title}</h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-4 text-caption text-muted-foreground">
            {fm.type ? <span>{t(($) => $.pages.type, { type: fm.type })}</span> : null}
            {fm.domains.length > 0 ? (
              <span>
                {t(($) => $.pages.domains, {
                  domains: fm.domains.map((d) => t(($) => $.domains[d as (typeof KNOWLEDGE_DOMAINS)[number]], { defaultValue: d })).join(" / "),
                })}
              </span>
            ) : null}
            {fm.verified && !page.needs_check ? (
              <span className="text-status-done">{t(($) => $.pages.verified, { by: fm.verified.by, at: fm.verified.at })}</span>
            ) : (
              <span className="text-status-progress">{t(($) => $.pages.unverified)}</span>
            )}
          </div>
          {page.sections.map((section, si) => (
            <section key={`${si}-${section.heading}`}>
              {section.heading ? <h2 className="mt-6 mb-2 text-title-sm font-semibold">{section.heading}</h2> : null}
              {section.paragraphs.map((para, pi) => (
                <p key={pi} className="mb-3 text-body-lg leading-[1.9]">
                  {para.map((s, ji) => (
                    <span key={ji}>
                      {slots.renderSentence ? slots.renderSentence(page, { text: s.text, key: `${si}-${pi}-${ji}` }) : s.text}
                      {s.cites.map((n) => (
                        <CiteMark key={n} n={n} source={sourcesByN.get(n)} />
                      ))}{" "}
                    </span>
                  ))}
                </p>
              ))}
              {slots.afterSection?.(page, si)}
            </section>
          ))}
          {page.sources.length > 0 ? (
            <div className="mt-8 border-t border-border pt-4">
              <h2 className="mb-2 text-caption text-muted-foreground">{t(($) => $.pages.sources)}</h2>
              <ol className="flex flex-col gap-1 text-body">
                {page.sources.map((s) => (
                  <li key={s.n} className="flex gap-2">
                    <span className="text-muted-foreground">[{s.n}]</span>
                    <SourceLabel source={s} />
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {page.backlinks.length > 0 ? (
            <div className="mt-6">
              <h2 className="mb-2 text-caption text-muted-foreground">{t(($) => $.pages.backlinks)}</h2>
              <div className="flex flex-wrap gap-1.5">
                {page.backlinks.map((b) => (
                  <Button key={b.path} size="xs" variant="secondary" onClick={() => onOpen(b.path)}>
                    {b.title}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </article>
      {slots.rail?.(page)}
    </div>
  );
}

function CiteMark({ n, source }: { n: number; source?: KnowledgeSource }) {
  const { t } = useT("knowledge");
  if (!source) return <sup className="ml-px text-micro text-status-review">[{n}]</sup>;

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <sup
            tabIndex={0}
            aria-label={t(($) => $.pages.source_n, { n })}
            className="ml-px cursor-default text-micro text-status-review"
          />
        }
      >
        [{n}]
      </HoverCardTrigger>
      <HoverCardContent className="w-80 text-caption">
        <div className="text-muted-foreground">{t(($) => $.sources[source.kind as SourceKind], { defaultValue: source.kind })}</div>
        <div className="mt-0.5 text-body">
          <SourceLabel source={source} />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Source kinds the server derives from a footnote URI (knowledge.SourceKind). */
type SourceKind = "task" | "chat" | "doc" | "pr" | "repo" | "web" | "text";

function SourceLabel({ source }: { source: KnowledgeSource }) {
  const { t } = useT("knowledge");
  if (source.kind === "chat") {
    if (!source.chat) return <span className="text-muted-foreground">{t(($) => $.sources.chat_missing)}</span>;
    const label = t(($) => $.sources.chat_label, {
      owner: source.chat.owner_name,
      agent: source.chat.agent_name,
      date: source.chat.created_at.slice(0, 10),
    });

    return (
      <span>
        {label}
        {source.chat.openable ? null : <span className="ml-2 text-caption text-muted-foreground">{t(($) => $.sources.private)}</span>}
      </span>
    );
  }
  const text = source.label || source.uri;

  return source.kind === "web" ? (
    <a href={source.uri} target="_blank" rel="noreferrer" className="break-all underline-offset-2 hover:underline">
      {text}
    </a>
  ) : (
    <span className="break-all">
      {source.label ? `${source.label} ` : null}
      {source.uri ? <span className="font-mono text-caption text-muted-foreground">{source.uri}</span> : null}
    </span>
  );
}
