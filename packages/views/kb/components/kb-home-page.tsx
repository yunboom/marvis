"use client";

import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbHomeOptions } from "@marvis/core/kb/queries";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";

function PendingCard({
  tone,
  label,
  count,
  hint,
}: {
  tone: "info" | "warning";
  label: string;
  count: number;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4">
      <span className="flex items-center gap-1.5 text-label text-muted-foreground">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "info" ? "bg-info" : "bg-warning")} />
        {label}
      </span>
      <span className="text-[26px] leading-tight font-semibold tabular-nums">{count}</span>
      {hint && <span className="min-w-0 truncate text-caption text-faint-foreground">{hint}</span>}
    </div>
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
  const { pathname } = useNavigation();
  const { kbSlug } = parseKbRoute(pathname);
  const { data: home, isLoading, isError } = useQuery(kbHomeOptions(wsId, kbSlug));

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
          <AppLink href={p.kb()} className="shrink-0 hover:text-foreground">
            {t(($) => $.list.title)}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {base.name}
          </span>
        </nav>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[900px] flex-col gap-7 px-14 py-8">
          <div>
            <h1 className="mb-2 text-[28px] leading-tight font-semibold">{base.name}</h1>
            {base.description && <p className="text-body text-muted-foreground">{base.description}</p>}
          </div>


          <section>
            <h2 className="mb-2.5 text-label font-semibold">{t(($) => $.home.pending_title)}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <PendingCard
                tone="info"
                label={t(($) => $.home.pending_reviews)}
                count={pending.open_mrs}
                hint={pending.latest_mr ? t(($) => $.home.latest_review, { title: pending.latest_mr.title }) : undefined}
              />
              <PendingCard
                tone="warning"
                label={t(($) => $.home.annotations)}
                count={pending.annotations}
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
                    <span className="shrink-0 font-medium">{item.title}</span>
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
    </div>
  );
}
