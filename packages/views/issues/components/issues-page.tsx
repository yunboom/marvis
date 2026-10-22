"use client";

import { ListTodo } from "lucide-react";
import type {
  Issue,
  IssueTableFacetSpec,
  IssueTableFacetsResponse,
  WorkingAgentSummary,
} from "@marvis/core/types";
import { useIssuesScope } from "@marvis/core/issues/stores/issues-scope-store";
import { useViewStore } from "@marvis/core/issues/stores/view-store-context";
import { PageHeader } from "../../layout/page-header";
import { RefreshablePageIcon } from "../../layout/refreshable-page-icon";
import { useT } from "../../i18n";
import { IssueSurface } from "../surface/issue-surface";
import { IssuesHeader } from "./issues-header";

// 任务页标题行：64px、24px 粗体标题，图标放大到 20px，不画底边线
export const ISSUES_PAGE_HEADER =
  "h-16 gap-2.5 border-b-0 [&>span:first-of-type]:size-5 [&>span:first-of-type_svg]:size-5";

function IssuesSurfaceHeader({
  issues,
  workingAgents,
  isRefreshing,
  facetCountsExact,
  tableFacetCounts,
  onTableFacetChange,
}: {
  issues: Issue[];
  workingAgents: WorkingAgentSummary[] | undefined;
  isRefreshing: boolean;
  facetCountsExact: boolean;
  tableFacetCounts?: IssueTableFacetsResponse;
  onTableFacetChange: (facet: IssueTableFacetSpec | null) => void;
}) {
  const { t } = useT("issues");
  const dateFilter = useViewStore((s) => s.dateFilter);
  const setDateFilter = useViewStore((s) => s.setDateFilter);

  return (
    <>
      <PageHeader className={ISSUES_PAGE_HEADER}>
        <RefreshablePageIcon refreshing={isRefreshing}>
          <ListTodo />
        </RefreshablePageIcon>
        <h1 className="truncate text-display-sm font-bold">{t(($) => $.page.breadcrumb_title)}</h1>
      </PageHeader>
      <IssuesHeader
        scopedIssues={issues}
        workingAgents={workingAgents}
        dateFilter={dateFilter}
        onDateFilterChange={setDateFilter}
        facetCountsExact={facetCountsExact}
        tableFacetCounts={tableFacetCounts}
        onTableFacetChange={onTableFacetChange}
      />
    </>
  );
}

export function IssuesPage() {
  const { t } = useT("issues");
  const scope = useIssuesScope("issues");

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <IssueSurface
        scope={{ type: "workspace", actorKind: scope }}
        modes={["board", "list", "table", "swimlane"]}
        batchToolbar="list"
        renderHeader={({ controller }) => (
          <IssuesSurfaceHeader
            issues={controller.surfaceIssues}
            workingAgents={controller.workingAgents}
            isRefreshing={controller.isRefreshing}
            facetCountsExact={controller.facetCountsExact}
            tableFacetCounts={controller.tableFacetCounts}
            onTableFacetChange={controller.setActiveTableFacet}
          />
        )}
        renderEmpty={() => (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground animate-content-rise">
            <ListTodo className="size-10 text-faint-foreground" />
            <p className="text-body-lg">{t(($) => $.page.empty_title)}</p>
          </div>
        )}
      />
    </div>
  );
}
