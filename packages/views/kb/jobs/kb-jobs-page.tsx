"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbJobListOptions, type KbJobListState } from "@marvis/core/kb/queries";
import type { KbJob } from "@marvis/core/types";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { Tabs, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { KB_TAG } from "../components/kb-cite-card";
import { parseKbJobRoute } from "./kb-job-state";

type Filter = "all" | KbJobListState;

const FILTERS: readonly Filter[] = ["all", "running", "failed"];

function JobRow({ kbSlug, job }: { kbSlug: string; job: KbJob }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const flagged = job.state === "running" || job.state === "failed";

  return (
    <li>
      <AppLink
        href={p.kbJob(kbSlug, job.id)}
        className="flex items-center gap-3 rounded-2xl px-3.5 py-3 transition-colors hover:bg-surface-hover"
      >
        <ActorAvatar actorType="agent" actorId={job.agent_id} name={job.agent_name || undefined} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-body font-semibold">{job.name}</span>
            {flagged && (
              <span className={cn(KB_TAG, "gap-1.5")}>
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", job.state === "running" ? "bg-success" : "bg-destructive")}
                />
                {t(($) => $.job.state[job.state])}
              </span>
            )}
            <span className="flex-1" />
            <span className="shrink-0 text-caption text-faint-foreground">{timeAgo(job.updated_at || job.created_at)}</span>
          </div>
          <div className="truncate text-label text-faint-foreground">
            {job.last_reply ? `${job.agent_name} · ${job.last_reply}` : job.agent_name}
          </div>
        </div>
      </AppLink>
    </li>
  );
}

/** The member's jobs of a knowledge base (design 9.1). */
export function KbJobsPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const { kbSlug } = parseKbJobRoute(pathname);
  const [filter, setFilter] = useState<Filter>("all");
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: jobs = [], isLoading } = useQuery(kbJobListOptions(wsId, kbSlug));

  const running = jobs.filter((job) => job.state === "running").length;
  const rows = filter === "all" ? jobs : jobs.filter((job) => job.state === filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {base?.name ?? kbSlug}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {t(($) => $.job.list_title)}
          </span>
        </nav>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[980px] flex-col gap-4 px-14 py-8 max-md:px-4">
          <div className="flex items-center gap-2">
            <h1 className="flex-1 text-title-lg font-semibold">{t(($) => $.job.list_title)}</h1>
            <IconButton
              label={t(($) => $.job.new)}
              size="icon"
              variant="secondary"
              tooltipSide="bottom"
              render={<AppLink href={p.kbNewJob(kbSlug)} />}
              nativeButton={false}
            >
              <Plus className="size-5" />
            </IconButton>
          </div>

          <Tabs value={filter} onValueChange={(next) => setFilter(next as Filter)}>
            <TabsList>
              {FILTERS.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(($) => $.job.tabs[value])}
                  {value === "running" && running > 0 && <span className="ml-1 tabular-nums">{running}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {!isLoading && rows.length === 0 && (
            <p className="py-6 text-label text-muted-foreground">{t(($) => $.job.empty)}</p>
          )}
          <ul className="flex flex-col gap-1">
            {rows.map((job) => (
              <JobRow key={job.id} kbSlug={kbSlug} job={job} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
