"use client";

import { useState, type ReactNode } from "react";
import { FileText, MessageSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { isOpenAnnotation, kbAnnotationListOptions, kbHomeOptions } from "@marvis/core/kb/queries";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";
import { KbAnnotationPanel } from "./kb-annotations";
import { KbSearchBox } from "./kb-search";

function PendingCard({
  tone,
  label,
  count,
  hint,
  href,
}: {
  tone: "info" | "warning";
  label: string;
  count: number;
  hint?: ReactNode;
  /** Where the card leads, when its list has a page. */
  href?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-label text-muted-foreground">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "info" ? "bg-info" : "bg-warning")} />
        {label}
      </span>
      <span className="text-display-sm font-semibold tabular-nums">{count}</span>
      {hint && <span className="min-w-0 truncate text-caption text-faint-foreground">{hint}</span>}
    </>
  );
  const className = "flex flex-col gap-1.5 rounded-xl border bg-card p-4";

  return href ? (
    <AppLink href={href} className={cn(className, "transition-colors hover:bg-surface-hover")}>
      {body}
    </AppLink>
  ) : (
    <div className={className}>{body}</div>
  );
}

const WELCOME_STEPS = ["ingest", "review", "read", "maintain"] as const;

/**
 * Onboarding shown once after a knowledge base is created: the four steps of
 * using it, ingesting first. Front-end copy only; nothing is started.
 */
function KbWelcomeGuide({ name, onDismiss }: { name: string; onDismiss: () => void }) {
  const { t } = useT("kb");

  return (
    <section className="flex flex-col gap-3" aria-label={t(($) => $.welcome.guide_title)}>
      <div role="status" className="flex items-center gap-2 rounded-xl bg-success/10 px-3.5 py-2.5 text-body">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
        <span className="min-w-0 flex-1">{t(($) => $.welcome.created, { name })}</span>
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          {t(($) => $.welcome.dismiss)}
        </Button>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border bg-card px-4.5 py-4">
        <h2 className="text-body font-semibold">{t(($) => $.welcome.guide_title)}</h2>
        <ol className="flex flex-col gap-3">
          {WELCOME_STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-px flex size-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-caption text-primary-foreground"
              >
                {index + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 text-body font-medium">
                  {t(($) => $.welcome.steps[step].title)}
                  {step === "ingest" && (
                    <span className="rounded-full bg-muted px-2 py-px text-micro font-normal text-muted-foreground">
                      {t(($) => $.welcome.suggested)}
                    </span>
                  )}
                </span>
                <span className="text-label leading-6 text-muted-foreground">
                  {t(($) => $.welcome.steps[step].description)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * The home page of a knowledge base is an overview: the base, its pending
 * work and recently merged pages. It embeds no page body.
 */
export function KbHomePage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const navigation = useNavigation();
  const { pathname } = navigation;
  const { kbSlug } = parseKbRoute(pathname);
  // Set by the builder right after creation (design 1.10).
  const welcome = navigation.searchParams.get("welcome") === "1";
  const { data: home, isLoading, isError } = useQuery(kbHomeOptions(wsId, kbSlug));
  const { data: kbAnnotations = [] } = useQuery(kbAnnotationListOptions(wsId, kbSlug, "all", "-"));
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const kbLevelOpen = kbAnnotations.filter(isOpenAnnotation).length;

  if (!home?.knowledge_base.id) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader>
          <span className="text-body text-muted-foreground">{t(($) => $.list.title)}</span>
        </PageHeader>
        <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
          {isError || !isLoading ? t(($) => $.home.not_found) : null}
        </div>
      </div>
    );
  }

  const { knowledge_base: base, pending, recent } = home;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <span aria-current="page" className="truncate font-medium text-foreground">
            {base.name}
          </span>
        </nav>
        <KbSearchBox kbSlug={kbSlug} />
        <button
          type="button"
          aria-label={t(($) => $.annotation.kb_panel)}
          aria-pressed={annotationsOpen}
          onClick={() => setAnnotationsOpen((open) => !open)}
          className="flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground aria-pressed:bg-surface-selected aria-pressed:text-foreground"
        >
          <MessageSquare className="size-4" />
          {kbLevelOpen > 0 && <span className="text-label tabular-nums">{kbLevelOpen}</span>}
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="flex max-w-[900px] flex-col gap-7 px-14 py-8">
            <div>
              <h1 className="mb-2 text-display-sm font-semibold">{base.name}</h1>
              {base.description && <p className="text-body text-muted-foreground">{base.description}</p>}
            </div>

            {welcome && <KbWelcomeGuide name={base.name} onDismiss={() => navigation.replace(p.kbBase(kbSlug))} />}

            <section>
              <h2 className="mb-2.5 text-label font-semibold">{t(($) => $.home.pending_title)}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <PendingCard
                  tone="info"
                  label={t(($) => $.home.pending_reviews)}
                  count={pending.open_mrs}
                  href={p.kbReviews(kbSlug)}
                  hint={pending.latest_mr ? t(($) => $.home.latest_review, { title: pending.latest_mr.title }) : undefined}
                />
                <PendingCard
                  tone="warning"
                  label={t(($) => $.home.annotations)}
                  count={pending.annotations}
                  href={p.kbAnnotations(kbSlug)}
                  hint={
                    pending.agent_reported > 0
                      ? t(($) => $.home.agent_reported, { count: pending.agent_reported })
                      : undefined
                  }
                />
                <PendingCard
                  tone="warning"
                  label={t(($) => $.home.stale_pages)}
                  count={pending.stale_pages}
                  href={p.kbStale(kbSlug)}
                  hint={t(($) => $.home.stale_hint)}
                />
              </div>
            </section>

            <section>
              <h2 className="mb-1 text-label font-semibold">{t(($) => $.home.recent_title)}</h2>
              {recent.length === 0 && (
                <p className="py-3 text-label text-muted-foreground">{t(($) => $.home.recent_empty)}</p>
              )}
              <ul>
                {recent.map((item) => (
                  <li key={item.page_id}>
                    <AppLink
                      href={p.kbPage(kbSlug, item.page_id)}
                      className="flex items-center gap-3 border-b border-border/50 px-1 py-[11px] hover:bg-surface-hover"
                    >
                      <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 text-body font-medium">{item.title}</span>
                      <span className="min-w-0 truncate text-label text-faint-foreground">{item.path}</span>
                      <span className="flex-1" />
                      <span className="min-w-0 truncate text-label text-faint-foreground">
                        {t(($) => $.home.recent_change, { number: item.mr_number, title: item.mr_title })}
                      </span>
                      <span className="w-[76px] shrink-0 text-right text-label text-faint-foreground">
                        {timeAgo(item.merged_at)}
                      </span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
        {annotationsOpen && (
          <KbAnnotationPanel kbSlug={kbSlug} createdBy={base.created_by} onClose={() => setAnnotationsOpen(false)} />
        )}
      </div>
    </div>
  );
}
