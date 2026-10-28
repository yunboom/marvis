"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbStalePagesOptions } from "@marvis/core/kb/queries";
import type { KbStalePage } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";
import { useKbJobRequests } from "../jobs/kb-job-prompts";
import { formatShortDate } from "./kb-page-body";

/**
 * Pages past their review date (design 2.5), opened from the home page's
 * "needs review" card. Each row hands its page to an agent as a health
 * check; the header hands all of them at once.
 */
export function KbStalePagesPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, push } = useNavigation();
  const { kbSlug } = parseKbRoute(pathname);
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: pages = [], isLoading } = useQuery(kbStalePagesOptions(wsId, kbSlug));
  const kbName = base?.name ?? kbSlug;
  const requests = useKbJobRequests();

  const checkPage = (page: KbStalePage) =>
    push(
      p.kbNewJob(kbSlug, {
        starter: "health",
        page: page.page_id,
      }),
    );
  const checkAll = () =>
    push(p.kbNewJob(kbSlug, { starter: "health", message: requests.staleAll({ id: base?.id ?? "", name: kbName }) }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {kbName}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {t(($) => $.home.stale_pages)}
          </span>
        </nav>
      </PageHeader>

      <div className="flex items-center gap-2.5 px-6 pt-4 pb-3">
        <span className="text-label text-muted-foreground">{t(($) => $.stale_list.count, { count: pages.length })}</span>
        <span className="flex-1" />
        <Button type="button" disabled={pages.length === 0} onClick={checkAll}>
          {t(($) => $.stale_list.hand_off_all)}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6">
        {!isLoading && pages.length === 0 && (
          <p className="py-6 text-label text-muted-foreground">{t(($) => $.stale_list.empty)}</p>
        )}
        {pages.length > 0 && (
          <table className="w-full table-fixed text-label">
            <thead>
              <tr className="h-10 border-b text-left text-caption text-muted-foreground">
                <th className="font-normal">{t(($) => $.stale_list.page)}</th>
                <th className="w-[40%] font-normal">{t(($) => $.stale_list.reason)}</th>
                <th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.page_id} className="h-16 border-b border-border/60">
                  <td className="min-w-0 pr-4">
                    <AppLink href={p.kbPage(kbSlug, page.page_id)} className="block truncate font-medium hover:underline">
                      {page.title || page.path}
                    </AppLink>
                    <span className="block truncate text-caption text-muted-foreground">{page.path}</span>
                  </td>
                  <td className="min-w-0 pr-4">
                    <span className="block truncate">{t(($) => $.stale_list.overdue)}</span>
                    {page.stale_after && (
                      <span className="block truncate text-caption text-muted-foreground">
                        {t(($) => $.stale_list.review_by, { date: formatShortDate(page.stale_after) })}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => checkPage(page)}>
                      {t(($) => $.stale_list.hand_off)}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
