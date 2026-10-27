"use client";

import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LayoutTemplate, Plus } from "lucide-react";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useIssueStatuses } from "@marvis/core/issue-statuses/hooks";
import { statusColumnKeys } from "@marvis/core/issues";
import { useIssueWorkflows } from "@marvis/core/issue-workflows";
import { projectListOptions } from "@marvis/core/projects/queries";
import { memberListOptions } from "@marvis/core/workspace/queries";
import type { IssueWorkflow, IssueWorkflowStep, Project } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../common/actor-avatar";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { CollectionPageHeader } from "../layout/collection-page";
import { PAGE_GUTTER } from "../layout/page-header";
import { ROUTE_ICON_COMPONENTS } from "../layout/route-icon-components";
import { useNavigation } from "../navigation";
import { IssueStatusesTab } from "../settings/components/issue-statuses-tab";
import { useT } from "../i18n";
import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from "./templates";
import { WorkflowEditorPage } from "./workflow-editor-page";

const WORKFLOW_PARAM = "workflow";
const DUPLICATE_PARAM = "from";
const TEMPLATE_PARAM = "template";
const NEW_WORKFLOW = "new";

const TAB_PARAM = "tab";
const WORKFLOWS_TAB = "workflows";
const STATUSES_TAB = "statuses";
type WorkflowsPageTab = typeof WORKFLOWS_TAB | typeof STATUSES_TAB;

const PAGE_TAB_TRIGGER =
  "h-full flex-none rounded-none px-0.5 group-data-horizontal/tabs:after:-bottom-px";

/** 标签页内容：可滚动，内容居中限宽。 */
const TAB_SCROLL = "min-h-0 flex-1 overflow-y-auto overscroll-contain";
const TAB_BODY = "mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:px-10 md:pt-8 md:pb-10";

/** 工作流列表里的一张卡片：独立描边、圆角 18，悬停浅灰。 */
const WORKFLOW_CARD =
  "flex w-full items-center gap-4 rounded-xl border border-surface-border bg-card py-4 pl-5 pr-4 text-left transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:duration-(--motion-instant)";

/**
 * Workflows page: the workflows on one tab, the status library they all draw
 * from on the other (`?tab=statuses`). `?workflow=<id>` (or `new`) opens the
 * editor in place, so a workflow is a linkable page rather than a dialog.
 */
export function WorkflowsPage() {
  const { t } = useT("issues");
  const { t: tLayout } = useT("layout");
  const navigation = useNavigation();
  const wsId = useWorkspaceId();
  const { workflows, isLoaded } = useIssueWorkflows(wsId);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentUser = useAuthStore((s) => s.user);
  const role = members.find((m) => m.user_id === currentUser?.id)?.role;
  const isAdmin = role === "owner" || role === "admin";
  // Any member creates workflows; a workflow's owner and admins edit it
  // (MUL-8120). Mirrors useWorkflowPermissions.
  const canCreate = !!role;
  const canEditWorkflow = (id: string) => {
    const owner = workflows.find((w) => w.id === id)?.owner_id;
    return isAdmin || (!!currentUser?.id && !!owner && owner === currentUser.id);
  };

  const tab: WorkflowsPageTab =
    navigation.searchParams.get(TAB_PARAM) === STATUSES_TAB ? STATUSES_TAB : WORKFLOWS_TAB;
  const open = navigation.searchParams.get(WORKFLOW_PARAM);
  const duplicateOf = navigation.searchParams.get(DUPLICATE_PARAM);
  const templateParam = navigation.searchParams.get(TEMPLATE_PARAM);
  const template = WORKFLOW_TEMPLATES.find((tpl) => tpl.id === templateParam)?.id ?? null;
  const hrefWith = (params: Record<string, string | null>) => {
    const next = new URLSearchParams(navigation.searchParams);
    for (const [key, value] of Object.entries(params)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return next.size ? `${navigation.pathname}?${next.toString()}` : navigation.pathname;
  };
  const openEditor = (id: string, from: WorkflowTemplateId | null = null) =>
    navigation.push(hrefWith({ [WORKFLOW_PARAM]: id, [DUPLICATE_PARAM]: null, [TEMPLATE_PARAM]: from }));
  const backToList = () =>
    navigation.push(hrefWith({ [WORKFLOW_PARAM]: null, [DUPLICATE_PARAM]: null, [TEMPLATE_PARAM]: null }));
  const switchTab = (next: WorkflowsPageTab) =>
    navigation.replace(hrefWith({ [TAB_PARAM]: next === STATUSES_TAB ? STATUSES_TAB : null }));

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workflow of workflows) {
      if (workflow.is_default) continue;
      for (const step of workflow.steps) counts.set(step.status_key, (counts.get(step.status_key) ?? 0) + 1);
    }
    return (key: string) => counts.get(key) ?? 0;
  }, [workflows]);

  if (open) {
    const seed = open === NEW_WORKFLOW && duplicateOf ? workflows.find((w) => w.id === duplicateOf) ?? null : null;
    return (
      <div className={TAB_SCROLL}>
        <WorkflowEditorPage
          key={`${open}:${duplicateOf ?? ""}:${template ?? ""}`}
          workflowId={open === NEW_WORKFLOW ? null : open}
          seed={seed}
          template={open === NEW_WORKFLOW && !duplicateOf ? template : null}
          canEdit={open === NEW_WORKFLOW ? canCreate : canEditWorkflow(open)}
          canDuplicate={canCreate}
          canCreateStatus={isAdmin}
          onBack={backToList}
          onOpen={(target) =>
            "id" in target
              ? navigation.replace(hrefWith({ [WORKFLOW_PARAM]: target.id, [DUPLICATE_PARAM]: null, [TEMPLATE_PARAM]: null }))
              : navigation.push(
                  hrefWith({ [WORKFLOW_PARAM]: NEW_WORKFLOW, [DUPLICATE_PARAM]: target.duplicateOf, [TEMPLATE_PARAM]: null }),
                )
          }
        />
      </div>
    );
  }

  const title = tLayout(($) => $.nav.workflows);
  const statusLibrary = <IssueStatusesTab workflowUsage={usage} />;

  const defaultProjects = projects.filter((p) => !p.workflow_id);
  const defaultRow = workflows.find((w) => w.is_default);

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-0"
      value={tab}
      onValueChange={(value) => switchTab(value as WorkflowsPageTab)}
    >
      <CollectionPageHeader
        icon={ROUTE_ICON_COMPONENTS.Workflow}
        title={title}
        actions={tab === WORKFLOWS_TAB && canCreate && <NewWorkflowMenu onCreate={openEditor} />}
      />

      <div className={cn("shrink-0 border-b border-border", PAGE_GUTTER)}>
        <TabsList variant="line" aria-label={title} className="gap-5 p-0 group-data-horizontal/tabs:h-10">
          <TabsTrigger value={WORKFLOWS_TAB} className={PAGE_TAB_TRIGGER}>
            {t(($) => $.workflows.settings.title)}
          </TabsTrigger>
          <TabsTrigger value={STATUSES_TAB} className={PAGE_TAB_TRIGGER}>
            {t(($) => $.workflows.settings.statuses_title)}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value={WORKFLOWS_TAB} className={cn(TAB_SCROLL, "data-hidden:hidden")}>
        <div className={cn(TAB_BODY, "space-y-4")}>
          {defaultRow ? (
            <WorkflowRow workflow={defaultRow} projects={defaultProjects} onOpen={() => openEditor(defaultRow.id)} />
          ) : (
            <DefaultWorkflowRow projects={defaultProjects} onOpen={() => switchTab(STATUSES_TAB)} />
          )}
          {isLoaded &&
            workflows.filter((w) => !w.is_default).map((workflow) => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                projects={projects.filter((p) => workflow.project_ids.includes(p.id))}
                onOpen={() => openEditor(workflow.id)}
              />
            ))}
        </div>
      </TabsContent>
      <TabsContent value={STATUSES_TAB} className={cn(TAB_SCROLL, "data-hidden:hidden")}>
        <div className={TAB_BODY}>{statusLibrary}</div>
      </TabsContent>
    </Tabs>
  );
}

/** 新建工作流：空白或从模板开始。 */
function NewWorkflowMenu({ onCreate }: { onCreate: (id: string, from?: WorkflowTemplateId | null) => void }) {
  const { t } = useT("issues");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="default" className="h-9 gap-1.5 pl-4 pr-3.5">
            <Plus className="size-3.5" />
            {t(($) => $.workflows.settings.new)}
            <ChevronDown className="size-3 opacity-70" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onClick={() => onCreate(NEW_WORKFLOW)}>
          <Plus className="size-3.5" />
          {t(($) => $.workflows.settings.new_blank)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.workflows.settings.from_template)}</DropdownMenuLabel>
          {WORKFLOW_TEMPLATES.map((tpl) => (
            <DropdownMenuItem key={tpl.id} className="items-start py-2" onClick={() => onCreate(NEW_WORKFLOW, tpl.id)}>
              <LayoutTemplate className="mt-0.5 size-3.5" />
              <span className="min-w-0">
                <span className="block font-medium">{t(($) => $.workflows.templates[tpl.id].name)}</span>
                <span className="block text-caption text-muted-foreground">
                  {t(($) => $.workflows.templates[tpl.id].summary)}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The implicit workflow of every project without one: the library itself. */
function DefaultWorkflowRow({ projects, onOpen }: { projects: Project[]; onOpen: () => void }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const keys = statusColumnKeys(catalog);
  const separator = t(($) => $.workflows.list_separator);
  return (
    <button type="button" className={WORKFLOW_CARD} onClick={onOpen}>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="whitespace-nowrap text-title-sm font-semibold">{t(($) => $.workflows.default_name)}</span>
        </div>
        <StepChain steps={keys.map((key) => ({ status_key: key, handler: { type: "none" }, instructions: "" }))} />
        <p className="text-label text-muted-foreground">
          {projects.length > 0
            ? t(($) => $.workflows.settings.used_by_default, {
                count: projects.length,
                names: projects.map((p) => p.title).join(separator),
              })
            : t(($) => $.workflows.settings.used_by_default_none)}
        </p>
      </div>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function WorkflowRow({
  workflow,
  projects,
  onOpen,
}: {
  workflow: IssueWorkflow;
  projects: Project[];
  onOpen: () => void;
}) {
  const { t } = useT("issues");
  const separator = t(($) => $.workflows.list_separator);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={WORKFLOW_CARD}
    >
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="whitespace-nowrap text-title-sm font-semibold">{workflow.name}</span>
          {workflow.description && (
            <span className="truncate text-label text-muted-foreground">{workflow.description}</span>
          )}
        </div>
        <StepChain steps={workflow.steps} />
        <p className="text-label text-muted-foreground">
          {workflow.is_default
            ? projects.length > 0
              ? t(($) => $.workflows.settings.used_by_default, {
                  count: projects.length,
                  names: projects.map((p) => p.title).join(separator),
                })
              : t(($) => $.workflows.settings.used_by_default_none)
            : projects.length > 0
              ? t(($) => $.workflows.settings.used_by, {
                  count: projects.length,
                  names: projects.map((p) => p.title).join(separator),
                })
              : t(($) => $.workflows.settings.no_projects)}
        </p>
      </div>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * A workflow's steps as a chain of chips, each with its handler. Side states
 * (the closed category and `blocked`) are left out so the chain reads as the
 * path an issue takes.
 */
function StepChain({ steps }: { steps: IssueWorkflowStep[] }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const path = steps.filter((s) => s.status_key !== "blocked" && catalog.categoryOf(s.status_key) !== "closed");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {path.map((step, index) => {
        const { type, id } = step.handler;
        return (
          <Fragment key={step.status_key}>
            {index > 0 && <ChevronRight aria-hidden className="size-3 text-faint-foreground" />}
            <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-field px-2.5 text-label">
              <StatusIcon
                status={step.status_key}
                category={catalog.categoryOf(step.status_key)}
                color={catalog.colorOf(step.status_key)}
                icon={catalog.iconOf(step.status_key)}
                className="h-3 w-3"
              />
              {labelOf(step.status_key)}
              {(type === "agent" || type === "squad" || type === "member") && id && (
                <ActorAvatar actorType={type} actorId={id} size="sm" profileLink={false} />
              )}
              {type === "project_lead" && (
                <span className="text-muted-foreground">· {t(($) => $.workflows.handler.project_lead)}</span>
              )}
              {type === "creator" && (
                <span className="text-muted-foreground">· {t(($) => $.workflows.handler.creator)}</span>
              )}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
