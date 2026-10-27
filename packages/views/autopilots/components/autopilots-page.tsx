"use client";

import {
  Fragment,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  Clock,
  Code,
  Pause,
  Plus,
  Webhook,
  Zap,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { autopilotListOptions } from "@marvis/core/autopilots/queries";
import {
  useAutopilotsViewStore,
  AUTOPILOT_SCOPES,
  type AutopilotColumnKey,
  type AutopilotScope,
} from "@marvis/core/autopilots/stores";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import type { Autopilot } from "@marvis/core/types";
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
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@marvis/ui/components/ui/tabs";
import { cn } from "@marvis/ui/lib/utils";
import { WorkspaceWakeupCreate, WorkspaceWakeups } from "./workspace-wakeups";
import { useNavigation, useRowLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { formatInTimeZone } from "../../common/format-in-time-zone";
import {
  COLLECTION_TABLE_INSET,
  CollectionPageHeader,
  CollectionPageHeaderAction,
  CollectionPageState,
} from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { AutopilotDialog } from "./autopilot-dialog";
import {
  AutopilotListToolbar,
  actorFilterValue,
} from "./autopilot-list-toolbar";
import { AutopilotRowActions } from "./autopilot-list-actions";
import { AUTOPILOT_TEMPLATES, type AutopilotTemplate } from "./autopilot-templates";
import { instructionsPreview } from "./instructions-preview";
import { RUN_VISUAL } from "./run-status";
import { useLocale, useT, useTimeAgo } from "../../i18n";

// Card geometry is the virtualizer's fixed-size contract: every card is
// exactly CARD_HEIGHT (title + two preview lines + one meta line), and each
// virtual row is one line of cards plus the gap below it.
const CARD_HEIGHT = 128;
const CARD_GAP = 12;
const CARD_ROW_HEIGHT = CARD_HEIGHT + CARD_GAP;

// Two cards per row from this container width up (Tailwind's @2xl, which
// the loading skeleton uses for the same switch); one card below it.
const TWO_COLUMN_MIN_WIDTH = 672;

const CARD_SURFACE =
  "rounded-2xl border border-border bg-card transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:duration-(--motion-instant)";

// 页内 Tab：40px 高，文字两侧留 2px，下划线压在分隔线上。
const PAGE_TAB_TRIGGER =
  "h-full flex-none rounded-none px-0.5 group-data-horizontal/tabs:after:-bottom-px";

// Columns follow the scroll container's width, not the viewport: the page
// lives inside resizable shells (sidebar, desktop split panes).
function useCardColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () =>
      setColumns(el.clientWidth >= TWO_COLUMN_MIN_WIDTH ? 2 : 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);

    return () => observer.disconnect();
  }, [ref]);

  return columns;
}

// Card meta line

const TRIGGER_ICONS: Record<string, typeof Zap> = {
  schedule: Clock,
  webhook: Webhook,
  api: Code,
};

// Dot color per last run outcome. Server-driven enum — unknown values fall
// through to the neutral dot, never crash (API compatibility rule).
function runStatusDotClass(status: string | null | undefined): string {
  return status && isKnownRunStatus(status) ? RUN_VISUAL[status].dot : "bg-faint-foreground";
}

const KNOWN_RUN_STATUSES = [
  "issue_created",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

type KnownRunStatus = (typeof KNOWN_RUN_STATUSES)[number];

function isKnownRunStatus(status: string): status is KnownRunStatus {
  return (KNOWN_RUN_STATUSES as readonly string[]).includes(status);
}

const META_ITEM = "flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap";

function ActorMeta({ type, id }: { type: string; id: string }) {
  const { getActorName } = useActorName();
  return (
    <span className={META_ITEM}>
      <ActorAvatar actorType={type} actorId={id} size="sm" />
      <span className="truncate">{getActorName(type, id)}</span>
    </span>
  );
}

function CardMeta({
  autopilot,
  isVisible,
}: {
  autopilot: Autopilot;
  isVisible: (key: AutopilotColumnKey) => boolean;
}) {
  const { t, i18n } = useT("autopilots");
  const timeAgo = useTimeAgo();
  const locale = useLocale();

  const items: { key: AutopilotColumnKey; node: ReactNode }[] = [];

  if (isVisible("assignee")) {
    items.push({
      key: "assignee",
      node: (
        <ActorMeta type={autopilot.assignee_type} id={autopilot.assignee_id} />
      ),
    });
  }

  const kinds = autopilot.trigger_kinds ?? [];
  if (isVisible("trigger") && kinds.length > 0) {
    // Server-driven enum: unknown kinds get a generic icon + raw label.
    const Icon = TRIGGER_ICONS[kinds[0] ?? ""] ?? Zap;
    const label = kinds
      .map((kind) =>
        kind === "schedule" || kind === "webhook" || kind === "api"
          ? t(($) => $.trigger_kind[kind])
          : kind,
      )
      .join(" + ");
    items.push({
      key: "trigger",
      node: (
        <span className={META_ITEM}>
          <Icon aria-hidden="true" className="size-3.25 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      ),
    });
  }

  if (isVisible("lastRun")) {
    const status = autopilot.last_run_status;
    items.push({
      key: "lastRun",
      node: autopilot.last_run_at ? (
        <span className={META_ITEM}>
          <span
            title={
              status && isKnownRunStatus(status)
                ? t(($) => $.run_status[status])
                : (status ?? undefined)
            }
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              runStatusDotClass(status),
            )}
          />
          <span className="tabular-nums">{timeAgo(autopilot.last_run_at)}</span>
        </span>
      ) : (
        <span className={cn(META_ITEM, "text-faint-foreground")}>
          {t(($) => $.page.never_run)}
        </span>
      ),
    });
  }

  if (isVisible("nextRun") && autopilot.next_run_at) {
    items.push({
      key: "nextRun",
      node: (
        <span className={cn(META_ITEM, "tabular-nums")}>
          {t(($) => $.page.next_run_at, {
            time: formatInTimeZone(autopilot.next_run_at, undefined, i18n.language),
          })}
        </span>
      ),
    });
  }

  if (isVisible("mode")) {
    const mode = autopilot.execution_mode;
    items.push({
      key: "mode",
      node: (
        <span className={META_ITEM}>
          {mode === "create_issue" || mode === "run_only"
            ? t(($) => $.execution_mode[mode])
            : mode}
        </span>
      ),
    });
  }

  if (isVisible("creator")) {
    items.push({
      key: "creator",
      node: (
        <ActorMeta
          type={autopilot.created_by_type}
          id={autopilot.created_by_id}
        />
      ),
    });
  }

  if (isVisible("created")) {
    items.push({
      key: "created",
      node: (
        <span className={cn(META_ITEM, "tabular-nums")}>
          {t(($) => $.page.created_at, {
            date: new Date(autopilot.created_at).toLocaleDateString(locale),
          })}
        </span>
      ),
    });
  }

  return (
    <div className="flex h-5 min-w-0 items-center overflow-hidden text-label text-muted-foreground">
      {items.map(({ key, node }, index) => (
        <Fragment key={key}>
          {index > 0 && (
            <span
              aria-hidden="true"
              className="shrink-0 px-1.5 text-faint-foreground"
            >
              ·
            </span>
          )}
          {node}
        </Fragment>
      ))}
    </div>
  );
}

// Card

function AutopilotCard({
  autopilot,
  isVisible,
  linkProps,
}: {
  autopilot: Autopilot;
  isVisible: (key: AutopilotColumnKey) => boolean;
  linkProps: ReturnType<ReturnType<typeof useRowLink>>;
}) {
  const { t } = useT("autopilots");
  const titleId = useId();
  const preview = useMemo(
    () => instructionsPreview(autopilot.description),
    [autopilot.description],
  );

  return (
    <div
      role="listitem"
      aria-labelledby={titleId}
      className={cn(
        CARD_SURFACE,
        "group/card relative flex min-w-0 cursor-pointer flex-col gap-1.5 px-4.5 py-4",
      )}
      style={{ height: CARD_HEIGHT }}
      {...linkProps}
    >
      <div className="flex min-w-0 items-center gap-2 pr-8">
        <span id={titleId} className="min-w-0 truncate text-body-lg font-semibold">
          {autopilot.title}
        </span>
        {/* Paused marker: in the "all" scope active and paused cards mix, so
            a paused automation needs an inline signal. */}
        {autopilot.status === "paused" && (
          <span
            title={
              autopilot.pause_reason === "agent_runtime_required"
                ? t(($) => $.status.paused_runtime_required)
                : t(($) => $.status.paused)
            }
            className="flex shrink-0 items-center text-warning"
          >
            <Pause className="size-3.25" />
          </span>
        )}
      </div>
      <p className="line-clamp-2 h-10 text-label leading-5 text-muted-foreground">
        {preview}
      </p>
      <CardMeta autopilot={autopilot} isVisible={isVisible} />
      <div className="absolute top-3 right-3">
        <AutopilotRowActions row={autopilot} />
      </div>
    </div>
  );
}

// 骨架卡片标题宽度交错，避免整齐划一的条纹感。
const SKELETON_TITLE_WIDTHS = ["w-40", "w-32", "w-44", "w-28", "w-36", "w-34"];

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
      {SKELETON_TITLE_WIDTHS.map((width, i) => (
        <div
          key={i}
          className="flex flex-col gap-1.5 rounded-2xl border border-border px-4.5 py-4"
          style={{ height: CARD_HEIGHT }}
        >
          <Skeleton className={cn("my-1 h-3.5 max-w-full rounded-full", width)} />
          <div className="flex h-10 flex-col justify-center gap-2">
            <Skeleton className="h-2.75 w-full rounded-full" />
            <Skeleton className="h-2.75 w-2/3 rounded-full" />
          </div>
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-2.75 w-16 rounded-full" />
            <Skeleton className="h-2.75 w-14 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

// "New autopilot" menu: a blank start plus every template, available with
// or without existing autopilots.

function NewAutopilotMenu({
  onCreate,
}: {
  onCreate: (template?: AutopilotTemplate) => void;
}) {
  const { t } = useT("autopilots");
  const label = t(($) => $.page.new_autopilot);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="default"
            aria-label={label}
            className="h-9 w-9 gap-1.5 px-0 text-body md:w-auto md:pr-3 md:pl-3.5"
          >
            <Plus aria-hidden="true" className="size-4" />
            <span className="hidden md:inline">{label}</span>
            <ChevronDown aria-hidden="true" className="hidden size-3.5 md:inline" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuItem onClick={() => onCreate()}>
          <Plus className="size-4" />
          {t(($) => $.page.start_blank)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.page.from_template)}</DropdownMenuLabel>
          {AUTOPILOT_TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <DropdownMenuItem
                key={tpl.id}
                className="items-start"
                onClick={() => onCreate(tpl)}
              >
                <Icon className="mt-0.5 size-4" />
                <span className="flex min-w-0 flex-col gap-px">
                  <span>{t(($) => $.templates[tpl.id].title)}</span>
                  <span className="text-caption text-muted-foreground">
                    {t(($) => $.templates[tpl.id].summary)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Page

export function AutopilotsPage() {
  const navigation = useNavigation();
  const tab =
    navigation.searchParams.get("tab") === "wakeups" ? "wakeups" : "autopilots";
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const rowLink = useRowLink();
  const {
    data: autopilots = [],
    isLoading,
    error: listError,
    refetch: refetchList,
  } = useQuery({
    ...autopilotListOptions(wsId),
    enabled: !!wsId && tab === "autopilots",
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [wakeupCreateOpen, setWakeupCreateOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
    useState<AutopilotTemplate | null>(null);
  // Persisted scope may hold a retired value (e.g. "archived" from an older
  // build) — fall back to "all" instead of stranding the user on an
  // unreachable scope.
  const rawScope = useAutopilotsViewStore((s) => s.scope);
  const scope = AUTOPILOT_SCOPES.includes(rawScope) ? rawScope : "all";
  const setScope = useAutopilotsViewStore((s) => s.setScope);
  const sortField = useAutopilotsViewStore((s) => s.sortField);
  const sortDirection = useAutopilotsViewStore((s) => s.sortDirection);
  const hiddenColumns = useAutopilotsViewStore((s) => s.hiddenColumns);
  const filters = useAutopilotsViewStore((s) => s.filters);
  const handleSortFieldSelect = useAutopilotsViewStore((s) => s.setSortField);
  const setSortDirection = useAutopilotsViewStore((s) => s.setSortDirection);
  const toggleColumn = useAutopilotsViewStore((s) => s.toggleColumn);
  const toggleFilter = useAutopilotsViewStore((s) => s.toggleFilter);
  const clearFilters = useAutopilotsViewStore((s) => s.clearFilters);

  const isFieldVisible = (key: AutopilotColumnKey) =>
    !hiddenColumns.includes(key);

  // Scope counts come from the FULL set (filters never affect them — they
  // are stage inventories, not result counts). API-archived rows (no UI
  // flow creates them) are excluded everywhere.
  const scopeCounts = useMemo<Record<AutopilotScope, number>>(() => {
    let active = 0;
    let paused = 0;
    for (const a of autopilots) {
      if (a.status === "archived") continue;
      if (a.status === "paused") paused++;
      else active++;
    }
    return { all: active + paused, active, paused };
  }, [autopilots]);

  // Rows within the current scope, unfiltered — toolbar option lists and
  // the "n / total" denominator derive from this.
  const scopeRows = useMemo<Autopilot[]>(() => {
    if (scope === "all") {
      return autopilots.filter((a) => a.status !== "archived");
    }
    return autopilots.filter((a) => a.status === scope);
  }, [autopilots, scope]);

  // Visible rows: filters, then sort.
  const rows = useMemo<Autopilot[]>(() => {
    const filtered = scopeRows.filter((a) => {
      if (
        filters.assignees.length > 0 &&
        !filters.assignees.includes(
          actorFilterValue(a.assignee_type, a.assignee_id),
        )
      ) {
        return false;
      }
      if (
        filters.modes.length > 0 &&
        !filters.modes.includes(a.execution_mode)
      ) {
        return false;
      }
      if (
        filters.triggerKinds.length > 0 &&
        !(a.trigger_kinds ?? []).some((k) => filters.triggerKinds.includes(k))
      ) {
        return false;
      }
      if (
        filters.creators.length > 0 &&
        !filters.creators.includes(
          actorFilterValue(a.created_by_type, a.created_by_id),
        )
      ) {
        return false;
      }
      return true;
    });

    const dir = sortDirection === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (sortField === "name") {
        return a.title.localeCompare(b.title) * dir;
      }
      if (sortField === "nextRun") {
        // Missing next run sorts last regardless of direction.
        const av = a.next_run_at ? Date.parse(a.next_run_at) : null;
        const bv = b.next_run_at ? Date.parse(b.next_run_at) : null;
        if (av === null && bv === null) return a.title.localeCompare(b.title);
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      }
      if (sortField === "created") {
        return (Date.parse(a.created_at) - Date.parse(b.created_at)) * dir;
      }
      // lastRun: never-ran rows sort as oldest.
      const av = a.last_run_at ? Date.parse(a.last_run_at) : 0;
      const bv = b.last_run_at ? Date.parse(b.last_run_at) : 0;
      return (av - bv) * dir || a.title.localeCompare(b.title);
    });
    return filtered;
  }, [scopeRows, filters, sortField, sortDirection]);

  // Card virtualization: one virtual item per line of cards, fixed height,
  // offsets applied as padding on the list.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const columns = useCardColumns(listScrollRef);
  const rowVirtualizer = useVirtualizer({
    count: Math.ceil(rows.length / columns),
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => CARD_ROW_HEIGHT,
    overscan: 5,
  });

  const openCreate = (template?: AutopilotTemplate) => {
    setSelectedTemplate(template ?? null);
    setCreateOpen(true);
  };

  const virtualItems = rowVirtualizer.getVirtualItems();
  const firstVirtual = virtualItems[0];
  const lastVirtual = virtualItems[virtualItems.length - 1];
  const virtualPadding = {
    top: firstVirtual ? firstVirtual.start : 0,
    bottom: lastVirtual ? rowVirtualizer.getTotalSize() - lastVirtual.end : 0,
  };

  const totalCount = autopilots.length;
  const showEmpty = !isLoading && !listError && totalCount === 0;

  return (
    <Tabs
      className="flex flex-1 min-h-0 flex-col gap-0"
      value={tab}
      onValueChange={(value) => {
        const params = new URLSearchParams(navigation.searchParams);
        if (value === "wakeups") params.set("tab", "wakeups");
        else params.delete("tab");
        navigation.replace(
          `${navigation.pathname}${params.size ? `?${params}` : ""}${navigation.hash}`,
        );
      }}
    >
      {/* Header */}
      <CollectionPageHeader
        icon={Zap}
        title={t(($) => $.page.title)}
        count={tab === "autopilots" ? totalCount : undefined}
        actions={
          tab === "autopilots" ? (
            <NewAutopilotMenu onCreate={openCreate} />
          ) : (
            <CollectionPageHeaderAction
              icon={Plus}
              variant="default"
              label={t(($) => $.wakeups.create)}
              onClick={() => setWakeupCreateOpen(true)}
            />
          )
        }
      />

      <div className={cn("shrink-0 border-b border-border", PAGE_GUTTER)}>
        <TabsList
          variant="line"
          aria-label={t(($) => $.page.title)}
          className="gap-5 p-0 group-data-horizontal/tabs:h-10"
        >
          <TabsTrigger value="autopilots" className={PAGE_TAB_TRIGGER}>
            {t(($) => $.page.title)}
          </TabsTrigger>
          <TabsTrigger value="wakeups" className={PAGE_TAB_TRIGGER}>
            {t(($) => $.wakeups.title)}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="wakeups"
        className="flex min-h-0 flex-col data-hidden:hidden"
      >
        <WorkspaceWakeups key={wsId} />
        <WorkspaceWakeupCreate open={wakeupCreateOpen} onOpenChange={setWakeupCreateOpen} />
      </TabsContent>
      <TabsContent
        value="autopilots"
        className="flex min-h-0 flex-col data-hidden:hidden"
      >
        {listError ? (
          <CollectionPageState
            role="alert"
            tone="destructive"
            icon={AlertCircle}
            title={
              listError instanceof Error ? listError.message : String(listError)
            }
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => refetchList()}
              >
                {t(($) => $.page.retry)}
              </Button>
            }
          />
        ) : isLoading ? (
          <div
            aria-busy="true"
            className={cn("flex-1 overflow-y-auto pt-3 @container", COLLECTION_TABLE_INSET)}
          >
            <LoadingSkeleton />
          </div>
        ) : showEmpty ? (
          <div className={cn("flex flex-col items-center pt-16 pb-16", PAGE_GUTTER)}>
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground">
              <Zap aria-hidden="true" className="size-6" />
            </span>
            <p className="mt-3.5 text-body-lg font-semibold">
              {t(($) => $.page.empty.title)}
            </p>
            <p className="mt-1.5 text-label text-muted-foreground">
              {t(($) => $.page.empty.hint)}
            </p>
            <div className="mt-7 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {AUTOPILOT_TEMPLATES.map((tpl) => {
                const Icon = tpl.icon;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    className={cn(CARD_SURFACE, "flex items-start gap-3 p-3.5 text-left")}
                    onClick={() => openCreate(tpl)}
                  >
                    <Icon className="mt-px size-5 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="text-body font-medium">
                        {t(($) => $.templates[tpl.id].title)}
                      </div>
                      <div className="line-clamp-2 text-label leading-normal text-muted-foreground">
                        {t(($) => $.templates[tpl.id].summary)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-5 gap-1.5 pr-3.5 pl-3"
              onClick={() => openCreate()}
            >
              <Plus className="size-3.5" />
              {t(($) => $.page.start_blank)}
            </Button>
          </div>
        ) : (
          <>
            <AutopilotListToolbar
              scope={scope}
              onScopeChange={setScope}
              scopeCounts={scopeCounts}
              filters={filters}
              onToggleFilter={toggleFilter}
              onClearFilters={clearFilters}
              sortField={sortField}
              sortDirection={sortDirection}
              onSortFieldChange={handleSortFieldSelect}
              onSortDirectionChange={setSortDirection}
              hiddenColumns={hiddenColumns}
              onToggleColumn={toggleColumn}
              allRows={scopeRows}
              visibleCount={rows.length}
            />
            <div
              ref={listScrollRef}
              className={cn("min-h-0 flex-1 overflow-y-auto pt-1 pb-6", COLLECTION_TABLE_INSET)}
            >
              {rows.length === 0 ? (
                <div className="py-16 text-center text-body text-muted-foreground">
                  {t(($) => $.page.no_matches)}
                </div>
              ) : (
                <div
                  role="list"
                  aria-label={t(($) => $.page.title)}
                  style={{
                    paddingTop: virtualPadding.top,
                    paddingBottom: virtualPadding.bottom,
                  }}
                >
                  {virtualItems.map((vi) => {
                    const lineCards = rows.slice(
                      vi.index * columns,
                      vi.index * columns + columns,
                    );
                    return (
                      <div
                        key={vi.key}
                        role="none"
                        className="grid"
                        style={{
                          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                          columnGap: CARD_GAP,
                          paddingBottom: CARD_GAP,
                        }}
                      >
                        {lineCards.map((autopilot) => (
                          <AutopilotCard
                            key={autopilot.id}
                            autopilot={autopilot}
                            isVisible={isFieldVisible}
                            linkProps={rowLink(
                              wsPaths.autopilotDetail(autopilot.id),
                              autopilot.title,
                            )}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {createOpen && (
          <AutopilotDialog
            mode="create"
            open={createOpen}
            onOpenChange={setCreateOpen}
            initial={
              selectedTemplate
                ? {
                    // Template title pulls from i18n so the user-visible default
                    // matches their locale, while the prompt body stays raw EN
                    // since it's injected directly into the agent task.
                    title: t(($) => $.templates[selectedTemplate.id].title),
                    description: selectedTemplate.prompt,
                  }
                : undefined
            }
            initialSchedule={
              selectedTemplate ? selectedTemplate.schedule : undefined
            }
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
