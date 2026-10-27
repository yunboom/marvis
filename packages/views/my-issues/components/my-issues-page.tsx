"use client";

import { useStore } from "zustand";
import { ListTodo } from "lucide-react";
import { useAuthStore } from "@marvis/core/auth";
import {
  myIssuesRelationFromScope,
  myIssuesViewStore,
} from "@marvis/core/issues/stores/my-issues-view-store";
import { PageHeader } from "../../layout/page-header";
import { RefreshablePageIcon } from "../../layout/refreshable-page-icon";
import { IssueSurface } from "../../issues/surface/issue-surface";
import { ISSUES_PAGE_HEADER } from "../../issues/components/issues-page";
import { useT } from "../../i18n";
import { MyIssuesHeader } from "./my-issues-header";

export function MyIssuesPage() {
  const { t } = useT("my-issues");
  const user = useAuthStore((s) => s.user);
  const scope = useStore(myIssuesViewStore, (s) => s.scope);
  const setScope = useStore(myIssuesViewStore, (s) => s.setScope);

  const renderTitle = (refreshing = false) => (
    <PageHeader className={ISSUES_PAGE_HEADER}>
      <RefreshablePageIcon refreshing={refreshing}>
        <ListTodo />
      </RefreshablePageIcon>
      <h1 className="truncate text-display-sm font-bold">{t(($) => $.page.breadcrumb)}</h1>
    </PageHeader>
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {user ? (
        <IssueSurface
          scope={{
            type: "my",
            userId: user.id,
            relation: myIssuesRelationFromScope(scope),
          }}
          modes={["board", "list", "table", "swimlane"]}
          batchToolbar="list"
          renderHeader={({ controller }) => (
            <>
              {renderTitle(controller.isRefreshing)}
              <MyIssuesHeader
                allIssues={controller.surfaceIssues}
                workingAgents={controller.workingAgents}
                scope={scope}
                onScopeChange={setScope}
                facetCountsExact={controller.facetCountsExact}
                tableFacetCounts={controller.tableFacetCounts}
                onTableFacetChange={controller.setActiveTableFacet}
              />
            </>
          )}
          renderEmpty={() => (
            <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground animate-content-rise">
              <ListTodo className="size-10 text-faint-foreground" />
              <p className="text-body-lg">{t(($) => $.page.empty_title)}</p>
              <p className="text-label">{t(($) => $.page.empty_description)}</p>
            </div>
          )}
        />
      ) : renderTitle()}
    </div>
  );
}
