"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, GitPullRequest, MessageSquareText, type LucideIcon } from "lucide-react";
import { ApiError } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  kbAnnotationOptions,
  kbBaseListOptions,
  kbMergeRequestByIdOptions,
  kbPageOptions,
} from "@marvis/core/kb";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import type { KbAnnotation, KbMergeRequestDetail, KbPage, KnowledgeBase } from "@marvis/core/types";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@marvis/ui/components/ui/hover-card";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT, useTimeAgo } from "../../i18n";
import { AppLink } from "../../navigation";
import { blockPlainText, blockSection } from "../utils/kb-markdown";
import { formatShortDate, pageTitle } from "./kb-page-body";
import { KbStateDot, type KbDot } from "./kb-diff";

/**
 * Knowledge base links in messages and comments (spec 7.14):
 * `mention://kb/<id>`, `mention://kb_page/<id>[#<block>]`, `mention://kb_mr/<id>`
 * and `mention://kb_annotation/<id>`. Each renders as a chip that opens its
 * target, with a hover card for the detail. Like issue and project links they
 * only link: nobody is notified and no agent starts.
 *
 * A link whose target cannot be read (deleted, another workspace, no access)
 * falls back to its text, as an issue chip does.
 */

/** The `mention://` types that are knowledge base links. */
export const KB_MENTION_TYPES = ["kb", "kb_page", "kb_mr", "kb_annotation"] as const;

export type KbMentionType = (typeof KB_MENTION_TYPES)[number];

export function isKbMentionType(type: string): type is KbMentionType {
  return (KB_MENTION_TYPES as readonly string[]).includes(type);
}

/** Splits a page mention id into the page and the optional block after `#`. */
export function splitKbPageMention(id: string): { pageId: string; blockId: string } {
  const hash = id.indexOf("#");
  if (hash < 0) return { pageId: id, blockId: "" };

  return { pageId: id.slice(0, hash), blockId: id.slice(hash + 1) };
}

/** Renders a knowledge base mention of any type; `label` is the link text. */
export function KbMention({ type, id, label }: { type: KbMentionType; id: string; label?: string }) {
  const text = label ?? "";
  switch (type) {
    case "kb":
      return <KbMentionCard kbId={id} label={text} />;
    case "kb_page": {
      const { pageId, blockId } = splitKbPageMention(id);
      return <KbPageMentionCard pageId={pageId} blockId={blockId} label={text} />;
    }
    case "kb_mr":
      return <KbChangeMentionCard mrId={id} label={text} />;
    case "kb_annotation":
      return <KbAnnotationMentionCard annotationId={id} label={text} />;
  }
}

// Shared chip

// Same box as IssueChip: it must sit inside a 14px line and never outgrow a
// line of prose or a chat bubble.
const CHIP_CLASS =
  "inline-flex min-w-0 max-w-[min(18rem,100%)] items-center gap-1.5 rounded-md border mx-0.5 px-2 py-0.5 text-caption align-middle";

function ChipBody({ icon: Icon, lead, title, tail }: { icon: LucideIcon; lead?: string; title: string; tail?: string }) {
  return (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      {lead && <span className="shrink-0 font-medium text-muted-foreground">{lead}</span>}
      <span className="min-w-0 truncate text-foreground">{title}</span>
      {tail && <span className="shrink-0 text-muted-foreground">› {tail}</span>}
    </>
  );
}

/** The plain text a link falls back to when its target cannot be read. */
function FallbackText({ label, note }: { label: string; note?: string }) {
  return (
    <span data-testid="kb-mention-fallback">
      {label}
      {note && <span className="text-muted-foreground"> · {note}</span>}
    </span>
  );
}

/**
 * A resolved chip: a link to the target with the hover card around it. The
 * wrapper stops clicks from reaching surrounding handlers, as the readonly
 * renderer does for issue chips.
 */
function KbChipLink({ href, label, card, children }: { href: string; label: string; card: ReactNode; children: ReactNode }) {
  return (
    <span className="inline align-middle" onClick={(e) => e.stopPropagation()}>
      <HoverCard>
        <HoverCardTrigger render={<span />}>
          <AppLink href={href} newTabTitle={label || undefined} className="kb-mention align-middle">
            <span className={cn(CHIP_CLASS, "cursor-pointer transition-colors hover:bg-accent")}>{children}</span>
          </AppLink>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-105 max-w-[calc(100vw-1rem)] p-0">
          {card}
        </HoverCardContent>
      </HoverCard>
    </span>
  );
}

/** A chip whose target is still loading: the link text, not yet clickable. */
function PendingChip({ icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className={CHIP_CLASS} data-testid="kb-mention-pending">
      <ChipBody icon={icon} title={label} />
    </span>
  );
}

function CardSection({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 border-border px-4 py-3 [&+&]:border-t">{children}</div>;
}

function CardRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">{children}</div>;
}

function CardTitle({ children }: { children: ReactNode }) {
  return <div className="text-title-sm font-semibold text-foreground">{children}</div>;
}

function CardQuote({ children }: { children: ReactNode }) {
  return <div className="line-clamp-3 border-l-2 border-border pl-2.5 text-label text-muted-foreground">{children}</div>;
}

function Sep() {
  return <span aria-hidden="true">·</span>;
}

/** The knowledge bases of the workspace by id: one cached list for every chip. */
function useKbBase(kbId: string): { base: KnowledgeBase | undefined; settled: boolean } {
  const wsId = useWorkspaceId();
  const { data, isPending } = useQuery(kbBaseListOptions(wsId));

  return { base: kbId ? data?.find((b) => b.id === kbId) : undefined, settled: !isPending };
}

// Knowledge base

export function KbMentionCard({ kbId, label }: { kbId: string; label: string }) {
  const p = useWorkspacePaths();
  const { base, settled } = useKbBase(kbId);

  if (!base) return settled ? <FallbackText label={label} /> : <PendingChip icon={BookOpen} label={label} />;

  return (
    <KbChipLink href={p.kbBase(base.slug)} label={base.name} card={<KbBaseCard base={base} />}>
      <ChipBody icon={BookOpen} title={base.name} />
    </KbChipLink>
  );
}

function KbBaseCard({ base }: { base: KnowledgeBase }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const { getMemberName } = useActorName();
  const pending = base.pending.annotations + base.pending.stale_pages + base.pending.open_mrs;

  return (
    <>
      <CardSection>
        <CardRow>
          <BookOpen aria-hidden="true" className="size-3.5" />
          {t(($) => $.mention.kb, { slug: base.slug })}
        </CardRow>
        <CardTitle>{base.name}</CardTitle>
        {base.description && <div className="line-clamp-2 text-label text-muted-foreground">{base.description}</div>}
      </CardSection>
      <CardSection>
        <CardRow>
          <span>{t(($) => $.search.pages, { count: base.page_count })}</span>
          <Sep />
          <span>{base.schema_mode === "custom" ? t(($) => $.mention.schema_custom) : t(($) => $.mention.schema_default)}</span>
          <Sep />
          <span>{pending > 0 ? t(($) => $.mention.pending, { count: pending }) : t(($) => $.mention.no_pending)}</span>
        </CardRow>
      </CardSection>
      <CardSection>
        <CardRow>
          <ActorAvatar actorType="member" actorId={base.created_by} size="xs" profileLink={false} />
          {t(($) => $.mention.created, { name: getMemberName(base.created_by), time: timeAgo(base.created_at) })}
        </CardRow>
      </CardSection>
    </>
  );
}

// Page

export function KbPageMentionCard({ pageId, blockId, label }: { pageId: string; blockId: string; label: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const page = useQuery(kbPageOptions(wsId, pageId, ""));
  const { base, settled } = useKbBase(page.data?.knowledge_base_id ?? "");

  if (page.isError) {
    // A deleted page reads as 404; so does one in another workspace, which a
    // link copied across workspaces is the only way to reach.
    const deleted = page.error instanceof ApiError && page.error.status === 404;
    return <FallbackText label={label} note={deleted ? t(($) => $.mention.page_deleted) : undefined} />;
  }
  if (page.isPending || (!base && !settled)) return <PendingChip icon={FileText} label={label} />;
  if (!base) return <FallbackText label={label} />;

  const title = pageTitle(page.data);
  const section = blockId ? blockSection(page.data.blocks, blockId) : "";
  const href = p.kbPage(base.slug, page.data.id) + (blockId ? `#${encodeURIComponent(blockId)}` : "");

  return (
    <KbChipLink href={href} label={title} card={<KbPageCard page={page.data} base={base} blockId={blockId} />}>
      <ChipBody icon={FileText} title={title} tail={section || undefined} />
    </KbChipLink>
  );
}

function KbPageCard({ page, base, blockId }: { page: KbPage; base: KnowledgeBase; blockId: string }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const title = pageTitle(page);
  const section = blockId ? blockSection(page.blocks, blockId) : "";
  const block = blockId ? page.blocks.find((b) => b.id === blockId) : undefined;
  const quote = block ? blockPlainText(block.content) : "";
  const parents = page.breadcrumb.filter((ref) => ref.id !== page.id).map((ref) => ref.title);
  const type = typeof page.frontmatter.type === "string" ? page.frontmatter.type : "";
  const staleAfter = typeof page.frontmatter.stale_after === "string" ? page.frontmatter.stale_after : "";

  return (
    <>
      <CardSection>
        <CardRow>
          <FileText aria-hidden="true" className="size-3.5" />
          <span>{[base.name, ...parents].join(" / ")}</span>
          {type && (
            <>
              <Sep />
              <span>{type}</span>
            </>
          )}
        </CardRow>
        <CardTitle>{section ? `${title} › ${section}` : title}</CardTitle>
        {quote && <CardQuote>{quote}</CardQuote>}
      </CardSection>
      <CardSection>
        <CardRow>
          <span>{t(($) => $.mention.claims, { count: page.claims.length })}</span>
          <Sep />
          <span>{t(($) => $.mention.open_annotations, { count: page.annotations_open })}</span>
          {staleAfter && (
            <>
              <Sep />
              <span className={page.stale ? "text-warning" : undefined}>
                {t(($) => $.mention.review_by, { date: formatShortDate(staleAfter) })}
              </span>
            </>
          )}
        </CardRow>
      </CardSection>
      {page.last_mr && (
        <CardSection>
          <CardRow>
            <span>{t(($) => $.mention.last_change, { number: page.last_mr.number })}</span>
            <Sep />
            <span>{t(($) => $.mention.merged, { name: page.last_mr.author_name, time: timeAgo(page.last_mr.merged_at) })}</span>
          </CardRow>
        </CardSection>
      )}
    </>
  );
}

// Merge request

const MR_DOT: Record<KbMergeRequestDetail["status"], KbDot> = { open: "blue", merged: "green", closed: "gray" };

export function KbChangeMentionCard({ mrId, label }: { mrId: string; label: string }) {
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const mr = useQuery(kbMergeRequestByIdOptions(wsId, mrId));

  if (mr.isPending) return <PendingChip icon={GitPullRequest} label={label} />;
  // A malformed body parses to a fallback without a knowledge base.
  if (mr.isError || !mr.data.knowledge_base_slug || mr.data.number <= 0) return <FallbackText label={label} />;

  return (
    <KbChipLink
      href={p.kbMergeRequest(mr.data.knowledge_base_slug, mr.data.number)}
      label={mr.data.title}
      card={<KbChangeCard mr={mr.data} />}
    >
      <ChipBody icon={GitPullRequest} lead={`#${mr.data.number}`} title={mr.data.title} />
    </KbChipLink>
  );
}

function KbChangeCard({ mr }: { mr: KbMergeRequestDetail }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const added = mr.pages.reduce((n, page) => n + page.added, 0);
  const deleted = mr.pages.reduce((n, page) => n + page.deleted, 0);
  const risk = mr.risk === "high" || mr.risk === "medium" || mr.risk === "low" ? mr.risk : "";
  const origin = useOriginLabel(mr);

  return (
    <>
      <CardSection>
        <CardRow>
          <KbStateDot dot={MR_DOT[mr.status] ?? "gray"} />
          <span>
            #{mr.number} · {t(($) => $.review.status[mr.status])}
          </span>
        </CardRow>
        <CardTitle>{mr.title}</CardTitle>
        {mr.summary && <div className="line-clamp-2 text-label text-muted-foreground">{mr.summary}</div>}
      </CardSection>
      <CardSection>
        <CardRow>
          <span>{mr.knowledge_base_name}</span>
          <Sep />
          <span>{t(($) => $.search.pages, { count: mr.pages.length })}</span>
          <span className="text-success">+{added}</span>
          <span className="text-destructive">−{deleted}</span>
          {risk && (
            <>
              <Sep />
              <span>{t(($) => $.mention.risk, { risk: t(($) => $.review.risk[risk]) })}</span>
            </>
          )}
        </CardRow>
      </CardSection>
      <CardSection>
        <CardRow>
          <ActorAvatar
            actorType={mr.author_type === "agent" ? "agent" : "member"}
            actorId={mr.author_id}
            name={mr.author_name || undefined}
            size="xs"
            profileLink={false}
          />
          <span>{t(($) => $.mention.submitted, { name: mr.author_name, time: timeAgo(mr.created_at) })}</span>
          {origin && (
            <>
              <Sep />
              <span>{t(($) => $.mention.origin, { origin })}</span>
            </>
          )}
        </CardRow>
      </CardSection>
    </>
  );
}

function useOriginLabel(mr: KbMergeRequestDetail): string {
  const { t } = useT("kb");
  switch (mr.origin.type) {
    case "none":
      return "";
    case "revert":
      return t(($) => $.review.origin.revert, { number: mr.reverts ?? 0 });
    default:
      return t(($) => $.review.origin[mr.origin.type as "kb_job" | "autopilot_run" | "issue" | "chat"], {
        label: mr.origin.label,
      });
  }
}

// Annotation

const ANNOTATION_DOT: Record<KbAnnotation["status"], KbDot> = {
  pending: "amber",
  processing: "blue",
  resolved: "green",
  dismissed: "gray",
};

/** How long the chip lets an annotation's body run before cutting it. */
const ANNOTATION_SUMMARY_LENGTH = 40;

export function KbAnnotationMentionCard({ annotationId, label }: { annotationId: string; label: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const annotation = useQuery(kbAnnotationOptions(wsId, annotationId));
  const { base, settled } = useKbBase(annotation.data?.knowledge_base_id ?? "");

  if (annotation.isError) return <FallbackText label={label} />;
  if (annotation.isPending || (!base && !settled)) return <PendingChip icon={MessageSquareText} label={label} />;
  if (!base) return <FallbackText label={label} />;

  const a = annotation.data;
  const where = a.page_id ? a.page_title : base.name;
  const summary = a.body.length > ANNOTATION_SUMMARY_LENGTH ? `${a.body.slice(0, ANNOTATION_SUMMARY_LENGTH)}…` : a.body;
  const href = a.page_id
    ? p.kbPage(base.slug, a.page_id) + (a.block_id && !a.anchor_lost ? `#${encodeURIComponent(a.block_id)}` : "")
    : p.kbAnnotations(base.slug);

  return (
    <KbChipLink href={href} label={where} card={<KbAnnotationCard annotation={a} base={base} />}>
      <ChipBody icon={MessageSquareText} lead={t(($) => $.mention.annotation)} title={summary ? `${where} · ${summary}` : where} />
    </KbChipLink>
  );
}

function KbAnnotationCard({ annotation: a, base }: { annotation: KbAnnotation; base: KnowledgeBase }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();

  return (
    <>
      <CardSection>
        <CardRow>
          <KbStateDot dot={ANNOTATION_DOT[a.status] ?? "gray"} />
          <span>{t(($) => $.mention.annotation_status, { status: t(($) => $.annotation.status[a.status]) })}</span>
          <Sep />
          <span>{a.page_id ? `${base.name} / ${a.page_title}` : base.name}</span>
        </CardRow>
        {a.quote && <CardQuote>{a.quote}</CardQuote>}
        <div className="line-clamp-4 text-label text-foreground">{a.body}</div>
      </CardSection>
      <CardSection>
        <CardRow>
          <ActorAvatar
            actorType={a.author_type}
            actorId={a.author_id}
            name={a.author_name || undefined}
            size="xs"
            profileLink={false}
          />
          <span>{t(($) => $.mention.recorded, { name: a.author_name, time: timeAgo(a.created_at) })}</span>
        </CardRow>
      </CardSection>
    </>
  );
}
