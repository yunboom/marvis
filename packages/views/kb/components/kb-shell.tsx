"use client";

import type { ReactNode } from "react";
import { Bot, Check, ChevronDown, GitMerge, History, House, Link2, MessageSquareText, MoreHorizontal, Network, Settings2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import { memberListOptions } from "@marvis/core/workspace/queries";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbBaseListOptions, kbJobListOptions, kbPageOptions } from "@marvis/core/kb/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { copyText } from "@marvis/ui/lib/clipboard";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { parseKbBuilderRoute } from "../builder/kb-builder-route";
import { parseKbRoute } from "../utils/kb-markdown";
import { parseKbJobRoute } from "../jobs/kb-job-state";
import { parseKbReviewRoute } from "../review/kb-review-route";
import { parseKbManageRoute } from "../manage/kb-manage-route";
import { KbPageTree, readsDraftDiff } from "./kb-page-tree";

export function KbInitial({ name, className }: { name: string; className?: string }) {
  // Array.from keeps a leading emoji or astral character whole.
  const initial = Array.from(name.trim())[0] ?? "";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-identity-gray text-caption font-semibold text-identity-gray-foreground",
        className,
      )}
    >
      {initial.toUpperCase()}
    </span>
  );
}

const NAV_ROW =
  "flex h-[34px] items-center gap-2 rounded-lg px-2 text-body text-foreground transition-colors hover:bg-surface-hover";

function KbSwitcher({ kbSlug, name }: { kbSlug: string; name: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { data: bases = [] } = useQuery(kbBaseListOptions(wsId));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.nav.switch)}
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 hover:bg-surface-hover data-popup-open:bg-surface-hover"
          >
            <KbInitial name={name} />
            <span className="min-w-0 truncate font-semibold">{name}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        {bases.map((base) => (
          <DropdownMenuItem key={base.id} render={<AppLink href={p.kbBase(base.slug)} />}>
            <KbInitial name={base.name} className="size-5" />
            <span className="min-w-0 flex-1 truncate">{base.name}</span>
            {base.slug === kbSlug && <Check aria-hidden="true" className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Whether the current member may configure a knowledge base: its creator or
 * a workspace owner / admin (the server enforces the same rule).
 */
export function useCanConfigureKb(createdBy: string | undefined): boolean {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id ?? "");
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const role = members.find((member) => member.user_id === userId)?.role;

  return !!userId && (createdBy === userId || role === "owner" || role === "admin");
}

function KbMoreMenu({ kbSlug, canConfigure }: { kbSlug: string; canConfigure: boolean }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const { getShareableUrl } = useNavigation();

  const copyLink = () => {
    void copyText(getShareableUrl(p.kbBase(kbSlug))).then((ok) => {
      if (ok) toast.success(t(($) => $.list.link_copied));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.nav.more_actions)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover hover:text-foreground data-popup-open:bg-surface-hover"
          >
            <MoreHorizontal className="size-4" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        {canConfigure && (
          <DropdownMenuItem render={<AppLink href={p.kbConfig(kbSlug)} />}>
            <MessageSquareText className="size-3.5" />
            <span className="flex-1">{t(($) => $.nav.configure)}</span>
            <span className="text-caption text-faint-foreground">{t(($) => $.nav.configure_hint)}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem render={<AppLink href={p.kbManage(kbSlug)} />}>
          <Settings2 className="size-3.5" />
          {t(($) => $.nav.manage)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<AppLink href={p.kbReviews(kbSlug)} />}>
          <GitMerge className="size-3.5" />
          {t(($) => $.review.title)}
        </DropdownMenuItem>
        <DropdownMenuItem render={<AppLink href={p.kbChanges(kbSlug)} />}>
          <History className="size-3.5" />
          {t(($) => $.review.changes.title)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={copyLink}>
          <Link2 className="size-3.5" />
          {t(($) => $.list.copy_link)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KbNav({
  kbSlug,
  pageId,
  draft,
  diff,
  onJobs,
  onGraph,
  onChanges,
}: {
  kbSlug: string;
  pageId: string;
  draft: string;
  /** The draft's edits are marked in the tree. */
  diff: boolean;
  onJobs: boolean;
  onGraph: boolean;
  /** A page reached from the "…" menu (change log, management): no nav row is current. */
  onChanges: boolean;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const canConfigure = useCanConfigureKb(base?.created_by);
  // Shares the reading page's query, so the breadcrumb that expands the tree
  // costs no extra request.
  const { data: page } = useQuery(kbPageOptions(wsId, pageId, draft));

  const { data: runningJobs = [] } = useQuery(kbJobListOptions(wsId, kbSlug, "running"));

  const pending = base ? base.pending.annotations + base.pending.stale_pages + base.pending.open_mrs : 0;
  const ancestorIds = page?.id === pageId ? page.breadcrumb.map((crumb) => crumb.id) : [];
  const onHome = !pageId && !onJobs && !onGraph && !onChanges;

  return (
    <aside
      aria-label={t(($) => $.nav.label)}
      className="flex w-[260px] shrink-0 flex-col border-r bg-sidebar/60 max-md:hidden"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-3">
        <KbSwitcher kbSlug={kbSlug} name={base?.name ?? kbSlug} />
        <KbMoreMenu kbSlug={kbSlug} canConfigure={canConfigure} />
      </div>
      <div className="flex flex-col gap-0.5 px-2 pt-2.5 pb-1">
        <AppLink
          href={p.kbBase(kbSlug)}
          aria-current={onHome ? "page" : undefined}
          className={cn(NAV_ROW, onHome && "bg-surface-selected font-medium text-foreground")}
        >
          <House aria-hidden="true" className="size-4" />
          <span className="flex-1">{t(($) => $.nav.home)}</span>
          {pending > 0 && (
            <span className="text-caption text-faint-foreground">{t(($) => $.nav.pending, { count: pending })}</span>
          )}
        </AppLink>
        <AppLink
          href={p.kbJobs(kbSlug)}
          aria-current={onJobs ? "page" : undefined}
          className={cn(NAV_ROW, onJobs && "bg-surface-selected font-medium text-foreground")}
        >
          <Bot aria-hidden="true" className="size-4" />
          <span className="flex-1">{t(($) => $.job.nav)}</span>
          {runningJobs.length > 0 && (
            <span className="flex items-center gap-1.5 text-caption text-faint-foreground">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              {t(($) => $.job.nav_running, { count: runningJobs.length })}
            </span>
          )}
        </AppLink>
        <AppLink
          href={p.kbGraph(kbSlug)}
          aria-current={onGraph ? "page" : undefined}
          className={cn(NAV_ROW, onGraph && "bg-surface-selected font-medium text-foreground")}
        >
          <Network aria-hidden="true" className="size-4" />
          <span className="flex-1">{t(($) => $.nav.graph)}</span>
        </AppLink>
      </div>
      <div className="px-4 pt-2 pb-1 text-caption text-muted-foreground">{t(($) => $.nav.pages)}</div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <KbPageTree kbSlug={kbSlug} selectedId={pageId} ancestorIds={ancestorIds} draft={draft} diff={diff} />
      </nav>
    </aside>
  );
}

/**
 * Frame of every knowledge base page: the knowledge base navigation (switcher,
 * home, page tree) beside the routed content. Web mounts it as the route
 * layout and desktop as the parent route element, so the tree keeps its
 * expanded state while pages change.
 */
export function KbShell({ children }: { children: ReactNode }) {
  const { pathname, searchParams } = useNavigation();
  const { kbSlug, pageId } = parseKbRoute(pathname);
  const draft = searchParams.get("draft") ?? "";

  const jobView = parseKbJobRoute(pathname).view;
  const reviewView = parseKbReviewRoute(pathname).view;
  const manageView = parseKbManageRoute(pathname).view;

  // The configuration builder (design 10.x), a job's conversation (9.2–9.17)
  // and review (8.x) are full-width flows of their own.
  if (parseKbBuilderRoute(pathname).mode === "config" || jobView === "new" || jobView === "job" || reviewView === "reviews") {
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      {kbSlug && <KbNav
          key={kbSlug}
          kbSlug={kbSlug}
          pageId={pageId}
          draft={draft}
          diff={readsDraftDiff(searchParams)}
          onJobs={jobView === "list"}
          onGraph={manageView === "graph"}
          onChanges={reviewView === "changes" || manageView === "manage"}
        />}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
