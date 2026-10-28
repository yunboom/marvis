"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Laptop,
  Loader2,
  Monitor,
  Plus,
  Search,
  Server,
  SquareTerminal,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  memberNeedsMikaSetup,
  useBootstrapMika,
} from "@marvis/core/onboarding";
import { MIKA_AVATAR_SRC } from "../../onboarding/components/mika-avatar";
import {
  useRequiredWorkspaceSlug,
  useWorkspacePaths,
} from "@marvis/core/paths";
import { agentTaskSnapshotOptions } from "@marvis/core/agents";
import { chatSessionsOptions } from "@marvis/core/chat/queries";
import { runtimeProfileListOptions } from "@marvis/core/runtimes";
import {
  runtimeListOptions,
  runtimeKeys,
} from "@marvis/core/runtimes/queries";
import { useWSEvent } from "@marvis/core/realtime";
import {
  agentListOptions,
  memberListOptions,
} from "@marvis/core/workspace/queries";
import type { AgentRuntime, MemberWithUser } from "@marvis/core/types";
import type { QoderConnection } from "@marvis/core/runtimes/qoder";
import { Badge } from "@marvis/ui/components/ui/badge";
import { Button, buttonVariants } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import {
  ListGrid,
  ListGridCell,
  ListGridHeader,
  ListGridHeaderCell,
  ListGridRow,
} from "@marvis/ui/components/ui/list-grid";
import {
  MikaRuntimeChoice,
  type MikaRuntimeSelection,
} from "./mika-runtime-choice";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import {
  COLLECTION_SEARCH_ICON,
  COLLECTION_SEARCH_INPUT,
  COLLECTION_TABLE_INSET,
  CollectionPageHeader,
} from "../../layout/collection-page";
import { PAGE_RAIL, PageHeader } from "../../layout/page-header";
import { cn } from "@marvis/ui/lib/utils";
import {
  AppLink,
  rowLinkInteractiveProps,
  useNavigation,
  useRowLink,
} from "../../navigation";
import { getMikaOnboarding, pickContentLang } from "../../onboarding/templates";
import { qoderOptions } from "@marvis/core/runtimes/qoder";
import { QODER_RUNTIME_LOCATOR } from "./qoder-detail-page";
import { RemoteRuntimeDialog } from "./remote-runtime-dialog";
import { ConnectRemoteDialog } from "./connect-remote-dialog";
import { CloudRuntimeDialog } from "./cloud-runtime-dialog";
import { ProviderLogo } from "./provider-logo";
import { RuntimeList, buildWorkloadIndex } from "./runtime-list";
import { pendingRuntimeFromProfile } from "./pending-runtime";
import { buildRuntimeMachines, type RuntimeMachine } from "./runtime-machines";
import { HealthDot, useHealthLabel } from "./shared";
import { useT, useTimeAgo } from "../../i18n";
import { DOCS_LINKS_ENABLED } from "../../common/docs-locale";
import { daemonRuntimesDocsHref } from "./runtime-docs";

export interface RuntimesPageProps {
  /** Desktop-only daemon id used to identify this device. */
  localDaemonId?: string | null;
  /** Desktop-only friendly device name for the local daemon. */
  localMachineName?: string | null;
  /** Keep the local device visible even before its first runtime registers. */
  hasLocalMachine?: boolean;
  /** The bundled daemon is starting but has not registered yet. */
  bootstrapping?: boolean;
  /** Web SaaS-only Cloud Runtime entrypoint. */
  cloudRuntimeEnabled?: boolean;
}

type StatusFilter = "all" | "online" | "offline";
const STATUS_FILTERS: StatusFilter[] = ["all", "online", "offline"];

type OwnerScope = "mine" | "all";
const OWNER_SCOPES: OwnerScope[] = ["mine", "all"];

const COMING_SOON_SERVICES = [
  { provider: "cursor", name: "Cursor Cloud Agents", vendor: "Cursor" },
  { provider: "claude", name: "Claude Managed Agents", vendor: "Anthropic" },
];

const QODER_CLOUD_PROVIDER = "qoder_cloud";

// Cloud services shown on this page and in the add menu. Qoder and Cursor are
// hidden for now but kept, so turning them back on is a one-line change.
const VISIBLE_CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

const SHOW_QODER_CLOUD = VISIBLE_CLOUD_PROVIDERS.has(QODER_CLOUD_PROVIDER);

const VISIBLE_COMING_SOON_SERVICES = COMING_SOON_SERVICES.filter((service) =>
  VISIBLE_CLOUD_PROVIDERS.has(service.provider),
);

// Coming-soon rows listed without the "By {vendor}" subtitle.
const NO_VENDOR_SUBTITLE_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

// Track order: edge, name, harness, agents, workload, status, actions, edge.
// Below @2xl only name, status and actions keep a track; the other cells are
// `hidden @2xl:flex` and drop out of subgrid placement. MUST stay a literal
// string so Tailwind sees the arbitrary template.
const GRID_COLS =
  "grid-cols-[0.5rem_minmax(160px,1fr)_112px_5.5rem_0.5rem] " +
  "@2xl:grid-cols-[0.5rem_minmax(120px,1fr)_128px_72px_168px_148px_5.5rem_0.5rem]";

const OPTIONAL_CELL = "hidden @2xl:flex";

// 表头单元格：13px 次要文字。
const HEAD_CELL = "text-label font-normal";

// 机器 / 云服务行：64px 高，细分隔线，悬停整行变浅灰。
const ROW =
  "h-auto min-h-16 border-b duration-(--motion-fast) ease-out hover:bg-accent hover:duration-(--motion-instant)";

// 行图标角上的状态点、Harness 叠放图标的描边：跟随行底色，悬停时一起变色。
const DOT_RING =
  "ring-2 ring-card transition-shadow group-hover/row:ring-accent";

// 引导行右侧的描边按钮：32px 药丸。
const ROW_ACTION_BUTTON = "h-8 gap-1.5 px-3.5 text-label font-normal";

// 分段控件：浅灰槽里放药丸按钮，选中项白底加阴影（同智能体页的范围切换）。
const SEGMENT_GROUP =
  "flex shrink-0 items-center gap-0.5 rounded-full bg-field p-0.75";
const SEGMENT_ON =
  "h-6.5 gap-1.5 px-3 text-label font-medium text-foreground shadow-control bg-surface hover:bg-surface dark:bg-white/12 dark:hover:bg-white/12";
const SEGMENT_OFF =
  "h-6.5 gap-1.5 px-3 text-label font-normal text-muted-foreground hover:bg-transparent hover:text-foreground";

// 名称旁的小标签（本机、即将推出），同智能体页的「你」。
const ROW_TAG =
  "shrink-0 rounded-xs bg-muted px-1 text-micro font-medium text-muted-foreground";

function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function qoderIsOnline(connection: QoderConnection): boolean {
  return (
    connection.configured &&
    connection.enabled &&
    connection.status === "online"
  );
}

export function RuntimesPage({
  localDaemonId,
  localMachineName,
  hasLocalMachine,
  bootstrapping,
  cloudRuntimeEnabled = false,
}: RuntimesPageProps = {}) {
  const { t, i18n } = useT("runtimes");
  const isAuthLoading = useAuthStore((state) => state.isLoading);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const paths = useWorkspacePaths();
  const { data: qoderConnection } = useQuery(qoderOptions(wsId));
  const navigation = useNavigation();
  const [qoderDialogOpen, setQoderDialogOpen] = useState(false);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [showCloudRuntimeDialog, setShowCloudRuntimeDialog] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [scope, setScope] = useState<OwnerScope>("all");

  const { data: runtimes = [], isLoading: runtimesLoading } = useQuery(
    runtimeListOptions(wsId),
  );
  const { data: runtimeProfiles = [], isLoading: profilesLoading } = useQuery(
    runtimeProfileListOptions(wsId),
  );
  const { data: agents = [], isLoading: agentsLoading } = useQuery(
    agentListOptions(wsId),
  );
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  // The Mika entrypoint is per member, not per workspace: the agent alone does
  // not say whether *this* member's conversation was ever opened and kicked
  // off. See memberNeedsMikaSetup.
  const { data: chatSessions = [], isLoading: chatSessionsLoading } = useQuery(
    chatSessionsOptions(wsId),
  );

  const handleDaemonEvent = useCallback(() => {
    qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
  }, [qc, wsId]);
  useWSEvent("daemon:register", handleDaemonEvent);

  const workloadIndex = useMemo(
    () => buildWorkloadIndex(agents, snapshot),
    [agents, snapshot],
  );
  const agentCountByRuntime = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      if (!agent.runtime_id) continue;
      counts.set(agent.runtime_id, (counts.get(agent.runtime_id) ?? 0) + 1);
    }
    return counts;
  }, [agents]);
  const now = useNowTick();
  const machines = useMemo(
    () =>
      buildRuntimeMachines(runtimes, {
        now,
        localDaemonId,
        localMachineName,
        currentUserId,
        workloadByRuntimeId: workloadIndex,
        ensureLocalMachine: hasLocalMachine,
      }),
    [
      runtimes,
      now,
      localDaemonId,
      localMachineName,
      currentUserId,
      workloadIndex,
      hasLocalMachine,
    ],
  );
  const orphanProfileRuntimes = useMemo(() => {
    if (machines.some((machine) => machine.mode === "local")) return [];
    return runtimeProfiles.map((profile) => {
      const createdAt = Date.parse(profile.created_at);
      return pendingRuntimeFromProfile({
        profile,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        fallbackMachineName: "Unassigned",
      });
    });
  }, [machines, runtimeProfiles]);

  if (isAuthLoading || runtimesLoading || profilesLoading) {
    return <RuntimesPageSkeleton />;
  }

  const isDesktop = hasLocalMachine === true;
  const qoder = SHOW_QODER_CLOUD ? (qoderConnection ?? null) : null;
  const qoderHref = paths.runtimeDetail(QODER_RUNTIME_LOCATOR);
  // Qoder's runtime registers like a machine, but it is listed once, as a
  // cloud service — never as a machine, even when this server cannot run
  // Qoder and the cloud row is hidden.
  const machineList = machines.filter(
    (machine) =>
      !(
        machine.runtimes.length > 0 &&
        machine.runtimes.every((runtime) => runtime.provider === "qoder_cloud")
      ),
  );
  const qoderAgentCount = agents.filter((agent) =>
    runtimes.some(
      (runtime) =>
        runtime.id === agent.runtime_id && runtime.provider === "qoder_cloud",
    ),
  ).length;
  const localMachine = machineList.find((machine) => machine.isCurrent);
  // "Mine" keeps this computer and machines the member owns. Cloud services
  // are shared by the workspace, so they show under either scope.
  const scopedMachines =
    scope === "mine"
      ? machineList.filter(
          (machine) =>
            machine.isCurrent ||
            machine.runtimes.some((runtime) => runtime.owner_id === currentUserId),
        )
      : machineList;

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || statusFilter !== "all" || scope !== "all";
  const matchesQuery = (...fields: (string | null | undefined)[]) =>
    !needle || fields.some((field) => field?.toLowerCase().includes(needle));
  const matchesStatus = (online: boolean) =>
    statusFilter === "all" || (statusFilter === "online") === online;
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setScope("all");
  };

  const visibleMachines = scopedMachines.filter(
    (machine) =>
      matchesStatus(machine.health === "online") &&
      matchesQuery(machine.title, machine.subtitle, ...machine.providerNames),
  );
  const qoderConfigured = qoder?.configured === true;
  const showQoderRow =
    qoder !== null &&
    matchesQuery(t(($) => $.qoder.cloud_title), "qoder") &&
    (statusFilter === "all" ||
      (qoderConfigured && matchesStatus(qoderIsOnline(qoder))));
  const visibleComingSoon =
    statusFilter === "all"
      ? VISIBLE_COMING_SOON_SERVICES.filter((service) =>
          matchesQuery(service.name, service.vendor),
        )
      : [];
  const showThisComputerRow =
    !filtering && !isDesktop && machineList.length === 0;
  const showAddMachineRow = !filtering && machineList.length === 0;
  const nothingMatches =
    filtering &&
    visibleMachines.length === 0 &&
    !showQoderRow &&
    visibleComingSoon.length === 0;

  const configuredCloudCount = qoderConfigured ? 1 : 0;
  const totalCount = machineList.length + configuredCloudCount;
  // Status counts follow the owner scope; search does not change them.
  const scopedCount = scopedMachines.length + configuredCloudCount;
  const onlineCount =
    scopedMachines.filter((machine) => machine.health === "online").length +
    (qoder && qoderIsOnline(qoder) ? 1 : 0);
  const statusCounts: Record<StatusFilter, number> = {
    all: scopedCount,
    online: onlineCount,
    offline: scopedCount - onlineCount,
  };
  const showMikaSetup =
    !agentsLoading &&
    !chatSessionsLoading &&
    memberNeedsMikaSetup(agents, chatSessions) &&
    runtimes.some((runtime) => runtime.provider !== "qoder_cloud");

  const openQoder = () =>
    qoderConfigured ? navigation.push(qoderHref) : setQoderDialogOpen(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader
        icon={Server}
        title={t(($) => $.page.title)}
        count={totalCount}
        learnMore={
          DOCS_LINKS_ENABLED
            ? {
                href: daemonRuntimesDocsHref(i18n.language),
                label: t(($) => $.page.learn_more),
              }
            : undefined
        }
        actions={
          <AddRuntimeMenu
            isDesktop={isDesktop}
            localMachineName={localMachineName ?? localMachine?.title ?? null}
            qoder={qoder}
            cloudRuntimeEnabled={cloudRuntimeEnabled}
            onAddMachine={() => setShowConnectDialog(true)}
            onQoder={openQoder}
            onCloudRuntime={() => setShowCloudRuntimeDialog(true)}
          />
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(PAGE_RAIL, COLLECTION_TABLE_INSET, "flex flex-col gap-3 pb-6")}>
          <RuntimesToolbar
            query={query}
            onQueryChange={setQuery}
            scope={scope}
            onScopeChange={setScope}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            counts={statusCounts}
          />

          {showMikaSetup && (
            <MikaSetupCard
              workspaceId={wsId}
              runtimes={runtimes.filter(
                (runtime) => runtime.provider !== "qoder_cloud",
              )}
              runtimesLoading={runtimesLoading}
            />
          )}

          <div className="@container">
            <ListGrid className={GRID_COLS}>
              <ListGridHeader className="static h-10 rounded-lg border-0 bg-surface-sunken text-muted-foreground after:hidden">
                <ListGridHeaderCell className={HEAD_CELL}>
                  {t(($) => $.page.columns.name)}
                </ListGridHeaderCell>
                <ListGridHeaderCell className={cn(OPTIONAL_CELL, HEAD_CELL)}>
                  {t(($) => $.page.columns.harness)}
                </ListGridHeaderCell>
                <ListGridHeaderCell className={cn(OPTIONAL_CELL, HEAD_CELL)}>
                  {t(($) => $.page.columns.agents)}
                </ListGridHeaderCell>
                <ListGridHeaderCell className={cn(OPTIONAL_CELL, HEAD_CELL)}>
                  {t(($) => $.page.columns.workload)}
                </ListGridHeaderCell>
                <ListGridHeaderCell className={HEAD_CELL}>
                  {t(($) => $.page.columns.status)}
                </ListGridHeaderCell>
                <ListGridHeaderCell aria-hidden="true" />
              </ListGridHeader>

              {nothingMatches ? (
                <div
                  role="row"
                  className="col-span-full flex flex-col items-center gap-1.5 px-4 py-16 text-center"
                >
                  <p className="text-body-lg font-medium">
                    {needle
                      ? t(($) => $.page.no_matches.with_query, {
                          query: query.trim(),
                          filterSuffix:
                            statusFilter !== "all" || scope !== "all"
                              ? t(($) => $.page.no_matches.with_query_filter_suffix)
                              : "",
                        })
                      : t(($) => $.page.no_matches.no_query)}
                  </p>
                  <p className="text-label text-muted-foreground">
                    {t(($) => $.page.no_matches.try_widening)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(ROW_ACTION_BUTTON, "mt-2.5")}
                    onClick={clearFilters}
                  >
                    {t(($) => $.page.no_matches.clear)}
                  </Button>
                </div>
              ) : (
                <>
                  <GroupHeader
                    title={t(($) => $.page.groups.machines.title)}
                    count={scopedMachines.length}
                  />
                  {visibleMachines.map((machine) => (
                    <MachineRow
                      key={machine.id}
                      machine={machine}
                      bootstrapping={bootstrapping}
                      currentUserId={currentUserId ?? null}
                      members={members}
                      agentCount={machine.runtimes.reduce(
                        (sum, runtime) =>
                          sum + (agentCountByRuntime.get(runtime.id) ?? 0),
                        0,
                      )}
                    />
                  ))}
                  {showThisComputerRow && (
                    <ActionRow
                      icon={Laptop}
                      title={t(($) => $.page.rows.this_computer_title)}
                      description={t(($) => $.page.rows.this_computer_hint)}
                      action={
                        <a
                          href={navigation.getShareableUrl("/download")}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" }),
                            ROW_ACTION_BUTTON,
                          )}
                        >
                          <Download aria-hidden="true" className="size-3.5" />
                          {t(($) => $.page.rows.download_desktop)}
                        </a>
                      }
                    />
                  )}
                  {showAddMachineRow && (
                    <ActionRow
                      icon={SquareTerminal}
                      title={t(($) => $.page.rows.add_machine_title)}
                      description={t(($) => $.page.rows.add_machine_hint)}
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          className={ROW_ACTION_BUTTON}
                          onClick={() => setShowConnectDialog(true)}
                        >
                          {t(($) => $.page.rows.view_commands)}
                        </Button>
                      }
                    />
                  )}

                  <GroupHeader
                    title={t(($) => $.page.groups.cloud.title)}
                    count={configuredCloudCount}
                  />
                  {showQoderRow && qoder && (
                    <QoderRow
                      connection={qoder}
                      agentCount={qoderAgentCount}
                      detailHref={qoderHref}
                      onConnect={() => setQoderDialogOpen(true)}
                    />
                  )}
                  {visibleComingSoon.map((service) => (
                    <ComingSoonRow key={service.provider} {...service} />
                  ))}
                </>
              )}
            </ListGrid>
          </div>

          {orphanProfileRuntimes.length > 0 && (
            <OrphanRuntimeProfiles
              runtimes={orphanProfileRuntimes}
              now={now}
              hasMachines={machines.length > 0}
            />
          )}
        </div>
      </div>

      {qoderDialogOpen && (
        <RemoteRuntimeDialog onClose={() => setQoderDialogOpen(false)} />
      )}
      {showConnectDialog && (
        <ConnectRemoteDialog onClose={() => setShowConnectDialog(false)} />
      )}
      {cloudRuntimeEnabled && showCloudRuntimeDialog && (
        <CloudRuntimeDialog onClose={() => setShowCloudRuntimeDialog(false)} />
      )}
    </div>
  );
}

function AddRuntimeMenu({
  isDesktop,
  localMachineName,
  qoder,
  cloudRuntimeEnabled,
  onAddMachine,
  onQoder,
  onCloudRuntime,
}: {
  isDesktop: boolean;
  localMachineName: string | null;
  qoder: QoderConnection | null;
  cloudRuntimeEnabled: boolean;
  onAddMachine: () => void;
  onQoder: () => void;
  onCloudRuntime: () => void;
}) {
  const { t } = useT("runtimes");
  const navigation = useNavigation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" className="h-9 gap-1.5 px-3 text-body font-medium">
            <Plus aria-hidden="true" className="size-4" />
            {t(($) => $.page.add)}
            <ChevronDown aria-hidden="true" className="size-3.5 opacity-70" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.page.add_menu.machines)}</DropdownMenuLabel>
          {isDesktop ? (
            <AddMenuItem
              icon={<Laptop className="size-4 text-muted-foreground" />}
              title={t(($) => $.page.add_menu.this_computer)}
              description={
                localMachineName
                  ? t(($) => $.page.add_menu.this_computer_connected, {
                      name: localMachineName,
                    })
                  : undefined
              }
              trailing={<Check className="size-4 text-muted-foreground" />}
              disabled
            />
          ) : (
            <AddMenuItem
              icon={<Laptop className="size-4 text-muted-foreground" />}
              title={t(($) => $.page.add_menu.this_computer)}
              description={t(($) => $.page.add_menu.this_computer_download)}
              render={
                <a
                  href={navigation.getShareableUrl("/download")}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            />
          )}
          <AddMenuItem
            icon={<SquareTerminal className="size-4 text-muted-foreground" />}
            title={t(($) => $.page.add_menu.other_machine)}
            description={t(($) => $.page.add_menu.other_machine_hint)}
            onClick={onAddMachine}
          />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.page.add_menu.cloud_services)}</DropdownMenuLabel>
          {qoder && (
            <AddMenuItem
              icon={<ProviderLogo provider="qoder_cloud" className="size-4" />}
              title={t(($) => $.qoder.cloud_title)}
              description={
                qoder.configured
                  ? t(($) => $.page.add_menu.qoder_manage_hint)
                  : t(($) => $.page.rows.provided_by, { vendor: "Qoder" })
              }
              trailing={
                qoder.configured ? (
                  <Check className="size-4 text-muted-foreground" />
                ) : undefined
              }
              onClick={onQoder}
            />
          )}
          {cloudRuntimeEnabled && (
            <AddMenuItem
              icon={<Cloud className="size-4 text-muted-foreground" />}
              title={t(($) => $.cloud_runtime.action)}
              description={t(($) => $.page.add_menu.cloud_runtime_hint)}
              onClick={onCloudRuntime}
            />
          )}
          {VISIBLE_COMING_SOON_SERVICES.map((service) => (
            <AddMenuItem
              key={service.provider}
              icon={<ProviderLogo provider={service.provider} className="size-4" />}
              title={service.name}
              description={t(($) => $.page.rows.provided_by, {
                vendor: service.vendor,
              })}
              trailing={
                <Badge variant="secondary" className="shrink-0">
                  {t(($) => $.page.groups.cloud.coming_soon)}
                </Badge>
              }
              disabled
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddMenuItem({
  icon,
  title,
  description,
  trailing,
  ...props
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  trailing?: ReactNode;
} & Omit<React.ComponentProps<typeof DropdownMenuItem>, "children" | "title">) {
  return (
    <DropdownMenuItem className="min-h-11 gap-2.5 px-2 py-1" {...props}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-row border bg-background">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium">{title}</span>
        {description && (
          <span className="truncate text-caption text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {trailing}
    </DropdownMenuItem>
  );
}

function RuntimesToolbar({
  query,
  onQueryChange,
  scope,
  onScopeChange,
  statusFilter,
  onStatusFilterChange,
  counts,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  scope: OwnerScope;
  onScopeChange: (scope: OwnerScope) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (filter: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
}) {
  const { t } = useT("runtimes");
  const statusLabels: Record<StatusFilter, string> = {
    all: t(($) => $.page.filters.all),
    online: t(($) => $.page.filters.online),
    offline: t(($) => $.page.filters.offline),
  };
  const scopeLabels: Record<OwnerScope, string> = {
    mine: t(($) => $.page.scope_mine),
    all: t(($) => $.page.scope_all),
  };

  return (
    <div className="flex h-12 min-w-0 items-center justify-between gap-3 px-2 pb-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className={COLLECTION_SEARCH_ICON} />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label={t(($) => $.page.search_placeholder)}
            placeholder={t(($) => $.page.search_placeholder)}
            className={cn(COLLECTION_SEARCH_INPUT, "w-full sm:w-56")}
          />
        </div>
        <div
          role="group"
          aria-label={t(($) => $.page.scope_label)}
          className={cn(SEGMENT_GROUP, "hidden md:flex")}
        >
          {OWNER_SCOPES.map((value) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={scope === value}
              className={scope === value ? SEGMENT_ON : SEGMENT_OFF}
              onClick={() => onScopeChange(value)}
            >
              {scopeLabels[value]}
            </Button>
          ))}
        </div>
        <div
          role="group"
          aria-label={t(($) => $.page.columns.status)}
          className={SEGMENT_GROUP}
        >
          {STATUS_FILTERS.map((filter) => (
            <Button
              key={filter}
              variant="ghost"
              size="sm"
              aria-pressed={statusFilter === filter}
              className={statusFilter === filter ? SEGMENT_ON : SEGMENT_OFF}
              onClick={() => onStatusFilterChange(filter)}
            >
              {statusLabels[filter]}
              <span className="font-normal tabular-nums text-muted-foreground">
                {counts[filter]}
              </span>
            </Button>
          ))}
        </div>
      </div>
      <TooltipHint label={t(($) => $.page.live_tooltip)}>
        <span className="hidden shrink-0 items-center gap-1.5 text-label text-muted-foreground sm:inline-flex">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-success" />
          {t(($) => $.page.live)}
        </span>
      </TooltipHint>
    </div>
  );
}

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div
      role="row"
      className="col-span-full flex h-10 min-w-0 items-end gap-1.5 px-4 pb-1.5 text-label"
    >
      <span className="font-semibold text-foreground">{title}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Server;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div
      role="row"
      className="col-span-full flex min-h-16 items-center gap-3 border-b px-4 py-2.5"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-input text-muted-foreground">
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="block truncate text-body font-medium">{title}</span>
        <span className="block truncate text-label text-muted-foreground">
          {description}
        </span>
      </span>
      <span className="shrink-0">{action}</span>
    </div>
  );
}

function RowTile({
  children,
  dot,
}: {
  children: ReactNode;
  dot?: ReactNode;
}) {
  return (
    <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-field">
      {children}
      {dot}
    </span>
  );
}

function NameCell({
  tile,
  title,
  href,
  badge,
  subtitle,
  muted,
}: {
  tile: ReactNode;
  title: string;
  href?: string;
  badge?: ReactNode;
  subtitle?: string;
  muted?: boolean;
}) {
  return (
    <ListGridCell className="gap-3 py-2.5">
      {tile}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {href ? (
            <AppLink
              href={href}
              className="truncate text-body font-medium focus-visible:outline-none focus-visible:underline"
              {...rowLinkInteractiveProps}
            >
              {title}
            </AppLink>
          ) : (
            <span
              className={cn(
                "truncate text-body font-medium",
                muted && "text-muted-foreground",
              )}
            >
              {title}
            </span>
          )}
          {badge}
        </span>
        {subtitle && (
          <span className="block truncate text-label text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
    </ListGridCell>
  );
}

function EmptyCell({ optional = true }: { optional?: boolean }) {
  return (
    <ListGridCell className={cn(optional && OPTIONAL_CELL, "text-label text-faint-foreground")}>
      —
    </ListGridCell>
  );
}

function RowChevron() {
  return (
    <ListGridCell className="justify-end">
      <ChevronRight
        aria-hidden="true"
        className="size-4 text-faint-foreground transition-transform group-hover/row:translate-x-0.5 group-hover/row:text-muted-foreground"
      />
    </ListGridCell>
  );
}

function WorkloadText({
  running,
  queued,
}: {
  running: number;
  queued: number;
}) {
  const { t } = useT("runtimes");
  if (running + queued === 0) {
    return (
      <span className="truncate text-label text-muted-foreground">
        {t(($) => $.machine.metrics.workload_idle)}
      </span>
    );
  }
  return (
    <span className="truncate text-label tabular-nums">
      {t(($) => $.machine.metrics.workload_hint, { running, queued })}
    </span>
  );
}

function MachineRow({
  machine,
  bootstrapping,
  currentUserId,
  members,
  agentCount,
}: {
  machine: RuntimeMachine;
  bootstrapping?: boolean;
  currentUserId: string | null;
  members: MemberWithUser[];
  agentCount: number;
}) {
  const { t } = useT("runtimes");
  const healthLabel = useHealthLabel();
  const timeAgo = useTimeAgo();
  const paths = useWorkspacePaths();
  const rowLink = useRowLink();
  const href = paths.runtimeDetail(machine.id);
  const Icon = machine.isCurrent
    ? Laptop
    : machine.section === "cloud"
      ? Cloud
      : Monitor;
  const ownerId = machine.runtimes[0]?.owner_id ?? null;
  const owner =
    ownerId && ownerId === currentUserId
      ? t(($) => $.page.rows.owner_you)
      : (members.find((member) => member.user_id === ownerId)?.name ?? null);
  const subtitle =
    [machine.deviceSummary, owner].filter(Boolean).join(" · ") ||
    (machine.section === "cloud"
      ? t(($) => $.machine.metrics.cloud_worker)
      : t(($) => $.machine.metrics.local_daemon));
  const starting =
    machine.isCurrent && bootstrapping && machine.runtimes.length === 0;
  const online = machine.health === "online";

  return (
    <ListGridRow
      className={cn(ROW, "cursor-pointer")}
      {...rowLink(href, machine.title)}
    >
      <NameCell
        tile={
          <RowTile
            dot={
              <HealthDot
                health={machine.health}
                className={cn("absolute -right-px -bottom-px size-2.5", DOT_RING)}
              />
            }
          >
            <Icon aria-hidden="true" className="size-4.5 text-muted-foreground" />
          </RowTile>
        }
        title={machine.title}
        href={href}
        badge={
          machine.isCurrent ? (
            <span className={ROW_TAG}>{t(($) => $.machine.this_machine)}</span>
          ) : undefined
        }
        subtitle={subtitle}
      />
      <ListGridCell className={OPTIONAL_CELL}>
        <ProviderIconStack providers={machine.providerNames} />
      </ListGridCell>
      <ListGridCell className={cn(OPTIONAL_CELL, "text-body tabular-nums")}>
        {agentCount}
      </ListGridCell>
      {online ? (
        <ListGridCell className={OPTIONAL_CELL}>
          <WorkloadText
            running={machine.runningCount}
            queued={machine.queuedCount}
          />
        </ListGridCell>
      ) : (
        <EmptyCell />
      )}
      <ListGridCell className="gap-1.5 text-label">
        {starting ? (
          <>
            <Loader2 aria-hidden="true" className="size-3 animate-spin text-muted-foreground" />
            <span className="truncate text-muted-foreground">
              {t(($) => $.page.bootstrapping.title)}
            </span>
          </>
        ) : (
          <TooltipHint label={t(($) => $.health[machine.health].description)}>
            <span className="flex min-w-0 items-center gap-1.5">
              <HealthDot health={machine.health} className="size-1.5 shrink-0" />
              <span className={cn("truncate", !online && "text-muted-foreground")}>
                {healthLabel(machine.health)}
                {!online && machine.lastSeenAt ? (
                  <span className="text-muted-foreground">
                    {` · ${timeAgo(machine.lastSeenAt)}`}
                  </span>
                ) : null}
              </span>
            </span>
          </TooltipHint>
        )}
      </ListGridCell>
      <RowChevron />
    </ListGridRow>
  );
}

function QoderRow({
  connection,
  agentCount,
  detailHref,
  onConnect,
}: {
  connection: QoderConnection;
  agentCount: number;
  detailHref: string;
  onConnect: () => void;
}) {
  const { t } = useT("runtimes");
  const rowLink = useRowLink();
  const title = t(($) => $.qoder.cloud_title);
  const logo = <ProviderLogo provider="qoder_cloud" className="size-4" />;
  const byQoder = t(($) => $.page.rows.provided_by, { vendor: "Qoder" });

  if (!connection.configured) {
    return (
      <ListGridRow className={ROW}>
        <NameCell
          tile={
            <RowTile
              dot={
                <span
                  className={cn(
                    "absolute -right-px -bottom-px size-2.5 rounded-full bg-warning",
                    DOT_RING,
                  )}
                />
              }
            >
              {logo}
            </RowTile>
          }
          title={title}
          subtitle={byQoder}
        />
        <EmptyCell />
        <EmptyCell />
        <EmptyCell />
        <ListGridCell>
          <Badge variant="secondary" className="bg-warning/10 text-warning">
            {t(($) => $.page.rows.not_connected)}
          </Badge>
        </ListGridCell>
        <ListGridCell className="justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 px-3.5 text-label font-normal"
            onClick={onConnect}
          >
            {t(($) => $.page.rows.connect)}
          </Button>
        </ListGridCell>
      </ListGridRow>
    );
  }

  const status = !connection.enabled
    ? "stopped"
    : connection.status === "online"
      ? "online"
      : connection.status === "error"
        ? "error"
        : connection.status === "offline"
          ? "offline"
          : "starting";
  const dotTone =
    status === "online"
      ? "bg-success"
      : status === "error"
        ? "bg-destructive"
        : status === "starting"
          ? "bg-warning"
          : "bg-muted-foreground/40";
  const subtitle =
    status === "error" && connection.lastError ? connection.lastError : byQoder;

  return (
    <ListGridRow
      className={cn(ROW, "cursor-pointer")}
      {...rowLink(detailHref, title)}
    >
      <NameCell
        tile={
          <RowTile
            dot={
              <span
                className={cn(
                  "absolute -right-px -bottom-px size-2.5 rounded-full",
                  DOT_RING,
                  dotTone,
                )}
              />
            }
          >
            {logo}
          </RowTile>
        }
        title={title}
        href={detailHref}
        subtitle={subtitle}
      />
      <EmptyCell />
      <ListGridCell className={cn(OPTIONAL_CELL, "text-body tabular-nums")}>
        {agentCount}
      </ListGridCell>
      {status === "online" ? (
        <ListGridCell className={OPTIONAL_CELL}>
          <WorkloadText
            running={connection.activeRuns}
            queued={connection.queuedRuns}
          />
        </ListGridCell>
      ) : (
        <EmptyCell />
      )}
      <ListGridCell className="gap-1.5 text-label">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotTone)} />
        <span
          className={cn(
            "truncate",
            status === "error" && "text-destructive",
            status !== "online" && status !== "error" && "text-muted-foreground",
          )}
        >
          {t(($) => $.qoder[status])}
        </span>
      </ListGridCell>
      <RowChevron />
    </ListGridRow>
  );
}

function ComingSoonRow({
  provider,
  name,
  vendor,
}: {
  provider: string;
  name: string;
  vendor: string;
}) {
  const { t } = useT("runtimes");
  return (
    <ListGridRow className={cn(ROW, "hover:bg-transparent")}>
      <NameCell
        tile={
          <RowTile>
            <span className="opacity-60">
              <ProviderLogo provider={provider} className="size-4" />
            </span>
          </RowTile>
        }
        title={name}
        subtitle={
          NO_VENDOR_SUBTITLE_PROVIDERS.has(provider)
            ? undefined
            : t(($) => $.page.rows.provided_by, { vendor })
        }
        muted
      />
      <EmptyCell />
      <EmptyCell />
      <EmptyCell />
      <ListGridCell>
        <span className={ROW_TAG}>{t(($) => $.page.groups.cloud.coming_soon)}</span>
      </ListGridCell>
      <ListGridCell aria-hidden="true" />
    </ListGridRow>
  );
}

/**
 * Entry point for creating Mika once a runtime exists.
 *
 * The action opens a picker rather than provisioning straight away. It used to
 * take `runtimes.find(online) ?? runtimes[0]` and create Mika on it silently —
 * but one machine commonly exposes every agent CLI it has installed (nine, on
 * the box this was reported from), so "the first online one" is arbitrary and
 * could well be a CLI the member never intended to run their Chief of Staff
 * on. Onboarding already makes this an explicit choice; this is the same
 * decision reached from a different entry point, so it asks the same way and
 * reuses the same two controls.
 */
function MikaSetupCard({
  workspaceId,
  runtimes,
  runtimesLoading,
}: {
  workspaceId: string;
  runtimes: AgentRuntime[];
  runtimesLoading?: boolean;
}) {
  const { t, i18n } = useT("runtimes");
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const wsSlug = useRequiredWorkspaceSlug();
  const bootstrapMika = useBootstrapMika(workspaceId);

  const [open, setOpen] = useState(false);
  // Seeded with the old heuristic so the dialog opens on a sensible default;
  // the point is that it is now visible and changeable, not that it is unset.
  const defaultRuntimeId =
    runtimes.find((runtime) => runtime.status === "online")?.id ??
    runtimes[0]?.id ??
    "";
  const [choice, setChoice] = useState<MikaRuntimeSelection | null>(null);

  const value: MikaRuntimeSelection = choice ?? {
    runtimeId: defaultRuntimeId,
    model: "",
  };
  const runtimeId = value.runtimeId;

  const handleStart = async () => {
    if (!runtimeId || bootstrapMika.isPending) return;
    const lang = pickContentLang(i18n.language);
    try {
      const result = await bootstrapMika.mutateAsync({
        workspaceSlug: wsSlug,
        runtimeId,
        model: value.model || undefined,
        ...getMikaOnboarding(lang),
      });
      setOpen(false);
      navigation.push(paths.chatSession(result.chatSession.id));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t(($) => $.mika_setup.failed),
      );
    }
  };

  return (
    <>
      <div className="flex animate-content-rise flex-col gap-3.5 rounded-xl bg-surface-sunken p-3.5 sm:flex-row sm:items-center sm:pr-4">
        <img
          src={MIKA_AVATAR_SRC}
          alt={t(($) => $.mika_setup.title)}
          className="size-10 shrink-0 select-none rounded-full object-cover"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-body-lg font-semibold">
            {t(($) => $.mika_setup.title)}
          </h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            {t(($) => $.mika_setup.description)}
          </p>
        </div>
        <Button className="h-9 shrink-0 px-4.5" onClick={() => setOpen(true)}>
          {t(($) => $.mika_setup.action)}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t(($) => $.mika_setup.dialog_title)}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <span className="text-body font-medium">
              {t(($) => $.mika_setup.runtime_label)}
            </span>
            <MikaRuntimeChoice
              layout="list"
              runtimes={runtimes}
              runtimesLoading={runtimesLoading}
              value={value}
              onChange={setChoice}
              disabled={bootstrapMika.isPending}
              modelLabel={t(($) => $.mika_setup.model_label)}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={bootstrapMika.isPending}
            >
              {t(($) => $.mika_setup.cancel)}
            </Button>
            <Button
              onClick={handleStart}
              disabled={!runtimeId || bootstrapMika.isPending}
            >
              {bootstrapMika.isPending && (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              )}
              {t(($) => $.mika_setup.action)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OrphanRuntimeProfiles({
  runtimes,
  now,
  hasMachines,
}: {
  runtimes: ReturnType<typeof pendingRuntimeFromProfile>[];
  now: number;
  hasMachines: boolean;
}) {
  const { t } = useT("runtimes");
  return (
    <section className={cn("px-2", hasMachines && "mt-4")}>
      <div className="mb-2">
        <h2 className="text-body font-semibold">
          {t(($) => $.profiles.unassigned_title)}
        </h2>
        <p className="mt-1 text-label text-muted-foreground">
          {t(($) => $.profiles.unassigned_description)}
        </p>
      </div>
      <div className="border-t">
        <RuntimeList runtimes={runtimes} now={now} />
      </div>
    </section>
  );
}

function ProviderIconStack({ providers }: { providers: string[] }) {
  const visible = providers.slice(0, 4);
  const extra = providers.length - visible.length;
  if (visible.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center -space-x-1.5">
      {visible.map((provider) => (
        <span
          key={provider}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-md bg-field",
            DOT_RING,
          )}
        >
          <ProviderLogo provider={provider} className="size-3.5" />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={cn(
            "inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-field px-1 text-micro font-semibold text-muted-foreground",
            DOT_RING,
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

function RuntimesPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="h-18 border-b-0">
        <Skeleton className="h-4.5 w-30 rounded-full" />
      </PageHeader>
      <div className={cn(PAGE_RAIL, COLLECTION_TABLE_INSET, "pt-14")}>
        <div className="h-10 rounded-lg bg-surface-sunken" />
        <div>
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="flex h-16 items-center gap-3 border-b px-4"
            >
              <Skeleton className="size-10 rounded-xl" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-44 rounded-full" />
                <Skeleton className="mt-2 h-3 w-28 rounded-full" />
              </div>
              <Skeleton className="hidden h-4 w-24 md:block" />
              <Skeleton className="hidden h-4 w-28 lg:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default RuntimesPage;
