import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { X, Plus, Pin, PinOff, ListX, AppWindow } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import {
  restrictToHorizontalAxis,
  restrictToParentElement,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@marvis/ui/components/ui/context-menu";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { useScrollFade } from "@marvis/ui/hooks/use-scroll-fade";
import { cn } from "@marvis/ui/lib/utils";
import { useTabStore, useActiveGroup, type Tab } from "@/stores/tab-store";
import { paths } from "@marvis/core/paths";
import { useT } from "@marvis/views/i18n";
import {
  useTabPresentation,
  ResourceLeadingVisual,
} from "@marvis/views/layout";
import { parseIssueWindowPath } from "../../../shared/issue-window";

const TAB_SCROLL_FADE_SIZE = 24;
const TAB_ENTRY_EASE = [0.22, 1, 0.36, 1] as const;

type TabSnapshot = {
  workspaceSlug: string | null;
  ids: Set<string>;
};

function getAddedTabIds(
  previous: TabSnapshot | null,
  workspaceSlug: string | null,
  currentIds: string[],
) {
  if (
    !previous ||
    previous.workspaceSlug !== workspaceSlug ||
    currentIds.length <= previous.ids.size
  ) {
    return [];
  }

  return currentIds.filter((id) => !previous.ids.has(id));
}

function getTabElement(
  scroller: HTMLDivElement,
  tabId?: string,
): HTMLElement | null {
  if (!tabId) {
    return scroller.querySelector<HTMLElement>('[data-tab-active="true"]');
  }

  return Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-tab-id]"),
  ).find((candidate) => candidate.dataset.tabId === tabId) ?? null;
}

function getTabScrollTarget(
  scroller: HTMLDivElement,
  tab: HTMLElement,
): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const hasHiddenLeft = scroller.scrollLeft > 1;
  const hasHiddenRight = scroller.scrollLeft < maxScrollLeft - 1;
  const visibleLeft =
    scrollerRect.left + (hasHiddenLeft ? TAB_SCROLL_FADE_SIZE : 0);
  const visibleRight =
    scrollerRect.right - (hasHiddenRight ? TAB_SCROLL_FADE_SIZE : 0);

  if (tabRect.left < visibleLeft) {
    return Math.max(0, scroller.scrollLeft - (visibleLeft - tabRect.left));
  }
  if (tabRect.right > visibleRight) {
    return Math.min(
      maxScrollLeft,
      scroller.scrollLeft + (tabRect.right - visibleRight),
    );
  }
  return scroller.scrollLeft;
}

// Keep scrolling scoped to the strip. Native scrollIntoView can also move
// scrollable desktop-shell ancestors and displace the whole window chrome.
function keepTabVisible(
  scroller: HTMLDivElement | null,
  tabId?: string,
  behavior: ScrollBehavior = "auto",
) {
  if (!scroller) return;
  const tab = getTabElement(scroller, tabId);
  if (!tab) return;

  const target = getTabScrollTarget(scroller, tab);
  if (Math.abs(target - scroller.scrollLeft) <= 1) return;

  if (behavior === "smooth" && typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ left: target, behavior: "smooth" });
    return;
  }
  scroller.scrollLeft = target;
}

function SortableTabItem({
  tab,
  isActive,
  isOnly,
  canCloseOthers,
  isNew,
  shouldReduceMotion,
  showSeparator,
}: {
  tab: Tab;
  isActive: boolean;
  /**
   * True iff this is the only tab in the workspace. Hiding X on the last
   * tab matches existing behavior and avoids the surprise of the store's
   * last-tab reseed kicking in. Pinned tabs always hide X (RFC §3 D3c).
   */
  isOnly: boolean;
  canCloseOthers: boolean;
  isNew: boolean;
  shouldReduceMotion: boolean;
  /**
   * Hairline on the tab's left edge — hidden next to the active tab, and
   * faded out while either of the two tabs it divides is hovered.
   */
  showSeparator: boolean;
}) {
  const { t } = useT("settings");
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const closeOtherTabs = useTabStore((s) => s.closeOtherTabs);
  const togglePin = useTabStore((s) => s.togglePin);
  const updateTab = useTabStore((s) => s.updateTab);
  const issueWindowPath = parseIssueWindowPath(tab.url);

  // The tab's leading visual and title are derived live from its URL and the
  // query cache — a resource's own icon/status/avatar and its real title,
  // updated as the cache updates. `tab.title` is only a persisted first-frame
  // fallback. See @marvis/views useTabPresentation.
  const { visual, title } = useTabPresentation(tab.url, tab.title);
  const pinLabel = tab.pinned
    ? t(($) => $.desktop.tab_bar.unpin)
    : t(($) => $.desktop.tab_bar.pin);
  const closeLabel = t(($) => $.desktop.tab_bar.close);
  const closeOthersLabel = t(($) => $.desktop.tab_bar.close_others);
  const openWindowLabel = t(($) => $.desktop.tab_bar.open_window);
  const tabName = tab.pinned
    ? t(($) => $.desktop.tab_bar.pinned_name, { title })
    : title;

  // Persist the active tab's resolved title so it survives as the next
  // session's first-frame fallback. The tab strip itself always renders the
  // live resolved `title`; `tab.title` is just the persisted seed. This
  // replaces the old document.title → MutationObserver → tab.title path (the OS
  // window title stays page-driven via useDocumentTitle).
  useEffect(() => {
    if (!isActive) return;
    if (tab.title !== title) updateTab(tab.id, { title });
  }, [isActive, title, tab.id, tab.title, updateTab]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  // Pin is a secondary interaction state, not an identity: a pinned tab keeps
  // its resource visual (a project's icon, an issue's status, an actor's
  // avatar) rather than collapsing to a Pin glyph. Pinned-ness is conveyed by
  // position, the suppressed close button, and the hover Pin/Unpin action.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    WebkitAppRegion: "no-drag",
    zIndex: isDragging ? 20 : undefined,
  } as React.CSSProperties;

  const handleClick = () => {
    if (isActive) return;
    setActiveTab(tab.id);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tab.id);
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    togglePin(tab.id);
  };

  const stopDragOnAction = (e: React.PointerEvent) => {
    e.stopPropagation();
  };

  const handleOpenAsWindow = () => {
    if (!issueWindowPath) return;
    void window.desktopAPI.openIssueWindow({
      path: issueWindowPath.path,
      title,
    });
  };

  // Pinned tabs keep their full title (RFC §3 D1v-ii FINAL). The only visual
  // differences vs. unpinned tabs are the suppressed X (closing requires
  // explicit Unpin) — the leading visual is the resource's own identity, same
  // as an unpinned tab. Pin/Unpin is reachable via the hover action button
  // below and the right-click menu.
  const showCloseButton = !tab.pinned && !isOnly;
  const [isEntering, setIsEntering] = useState(isNew && !shouldReduceMotion);
  const [showAddedHighlight, setShowAddedHighlight] = useState(isNew);

  useEffect(() => {
    if (!isDragging) return;
    setIsEntering(false);
    setShowAddedHighlight(false);
  }, [isDragging]);

  const tabButton = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      onClick={handleClick}
      // Browser convention: middle click closes the tab. Pinned (and sole)
      // tabs suppress the close affordance, so middle click follows suit.
      onAuxClick={(e) => {
        if (e.button !== 1 || !showCloseButton) return;
        e.preventDefault();
        handleClose(e);
      }}
      aria-label={tabName}
      data-tab-active={isActive ? "true" : undefined}
      data-tab-entering={isEntering ? "true" : undefined}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className={cn(
        // 28px 药丸：图标、标题、悬停操作在顶部条里垂直居中。
        "group relative flex size-full min-w-0 items-center gap-1.5 rounded-full px-3 text-caption transition-colors duration-(--motion-fast) ease-out",
        "select-none cursor-default",
        isActive
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
        isDragging && "opacity-60",
      )}
    >
      <ResourceLeadingVisual visual={visual} />
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left"
        style={{
          maskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
          WebkitMaskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
        }}
      >
        {title}
      </span>
      <span
        onClick={handleTogglePin}
        onPointerDown={stopDragOnAction}
        role="button"
        aria-label={pinLabel}
        title={pinLabel}
        className="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out group-hover:flex hover:bg-surface-selected hover:text-foreground"
      >
        {tab.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
      </span>
      {showCloseButton && (
        <span
          onClick={handleClose}
          onPointerDown={stopDragOnAction}
          role="button"
          aria-label={closeLabel}
          className="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out group-hover:flex hover:bg-surface-selected hover:text-foreground"
        >
          <X className="size-3" />
        </span>
      )}
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-tab-frame
      data-tab-id={tab.id}
      className={cn("h-7 w-40 min-w-32", isActive && "z-10")}
    >
      <motion.div
        className="group/tab relative size-full"
        initial={isEntering ? { opacity: 0, x: 8 } : false}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: isEntering ? 0.18 : 0, ease: TAB_ENTRY_EASE }}
        onAnimationComplete={() => setIsEntering(false)}
      >
        {isActive ? (
          // 选中标签：白底药丸 + 控件阴影，浮在灰色外壳上，与 web 分段控件选中项一致。
          <span
            aria-hidden
            data-tab-pill="active"
            className={cn(
              "pointer-events-none absolute inset-x-0.5 inset-y-0 rounded-full bg-background shadow-control",
              isDragging && "opacity-60",
            )}
          />
        ) : (
          <span
            aria-hidden
            data-tab-pill="hover"
            className="pointer-events-none absolute inset-x-0.5 inset-y-0 rounded-full bg-surface-hover opacity-0 transition-opacity duration-(--motion-fast) ease-out group-hover/tab:opacity-100 group-hover/tab:duration-(--motion-instant)"
          />
        )}
        {showSeparator && (
          // Fades in step with the neighbouring hover pill: both use a bare
          // transition-opacity, so the hairline clears exactly as the pill
          // arrives rather than lingering 2px off its rounded edge.
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-1.5 h-4 w-px bg-surface-border transition-opacity duration-(--motion-fast) ease-out group-hover/tab:opacity-0 group-hover/tab:duration-(--motion-instant) prev-tab-hover:opacity-0 prev-tab-hover:duration-(--motion-instant)"
          />
        )}
        <ContextMenu>
          <TooltipHint label={tab.pinned ? tabName : undefined} side="bottom">
            <ContextMenuTrigger render={tabButton} />
          </TooltipHint>
          <ContextMenuContent>
            {issueWindowPath && (
              <>
                <ContextMenuItem onClick={handleOpenAsWindow}>
                  <AppWindow />
                  {openWindowLabel}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem onClick={() => togglePin(tab.id)}>
              {tab.pinned ? (
                <>
                  <PinOff />
                  {pinLabel}
                </>
              ) : (
                <>
                  <Pin />
                  {pinLabel}
                </>
              )}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={tab.pinned || isOnly}
              onClick={() => closeTab(tab.id)}
            >
              <X />
              {closeLabel}
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              disabled={!canCloseOthers}
              onClick={() => closeOtherTabs(tab.id)}
            >
              <ListX />
              {closeOthersLabel}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {showAddedHighlight && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-x-0.5 inset-y-0 rounded-full bg-primary/10 ring-1 ring-inset ring-primary/20"
            initial={{ opacity: shouldReduceMotion ? 0.25 : 0.65 }}
            animate={{ opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0.16 : 0.42 }}
            onAnimationComplete={() => setShowAddedHighlight(false)}
          />
        )}
      </motion.div>
    </div>
  );
}

function NewTabEdgeFeedback({
  newTabId,
  scrollerRef,
  shouldReduceMotion,
}: {
  newTabId: string | null;
  scrollerRef: RefObject<HTMLDivElement | null>;
  shouldReduceMotion: boolean;
}) {
  const sequenceRef = useRef(0);
  const [signal, setSignal] = useState<{
    tabId: string;
    sequence: number;
  } | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !newTabId) return;
    const tab = getTabElement(scroller, newTabId);
    if (!tab || getTabScrollTarget(scroller, tab) === scroller.scrollLeft) {
      return;
    }

    sequenceRef.current += 1;
    setSignal({ tabId: newTabId, sequence: sequenceRef.current });
  }, [newTabId, scrollerRef]);

  if (!signal) return null;

  return (
    <motion.div
      key={`${signal.tabId}-${signal.sequence}`}
      aria-hidden
      data-new-tab-edge-feedback="true"
      className="pointer-events-none absolute top-1.5 bottom-1.5 right-0 z-20 w-8 rounded-r-full bg-gradient-to-l from-primary/35 via-primary/10 to-transparent"
      initial={{
        opacity: shouldReduceMotion ? 0.45 : 0,
        x: shouldReduceMotion ? 0 : 4,
      }}
      animate={{
        opacity: shouldReduceMotion ? [0.45, 0] : [0, 0.8, 0],
        x: 0,
      }}
      transition={{
        opacity: {
          duration: shouldReduceMotion ? 0.2 : 0.45,
          times: shouldReduceMotion ? [0, 1] : [0, 0.18, 1],
          ease: "easeOut",
        },
        x: {
          duration: shouldReduceMotion ? 0 : 0.18,
          ease: TAB_ENTRY_EASE,
        },
      }}
      onAnimationComplete={() => {
        setSignal((current) =>
          current?.sequence === signal.sequence ? null : current,
        );
      }}
    />
  );
}

function NewTabButton() {
  const { t } = useT("settings");
  const addTab = useTabStore((s) => s.addTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const newTabLabel = t(($) => $.desktop.tab_bar.new);

  const handleClick = () => {
    // New tab opens in the currently active workspace — tabs are scoped
    // per workspace, so there is no cross-workspace ambiguity to resolve.
    const activeSlug = useTabStore.getState().activeWorkspaceSlug;
    if (!activeSlug) return;
    const path = paths.workspace(activeSlug).issues();
    const tabId = addTab(path, "Issues");
    if (tabId) setActiveTab(tabId);
  };

  return (
    <TooltipHint label={newTabLabel} side="bottom">
      <button
        type="button"
        onClick={handleClick}
        aria-label={newTabLabel}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        className="flex size-7 shrink-0 items-center justify-center self-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-surface-hover hover:text-foreground hover:duration-(--motion-instant)"
      >
        <Plus className="size-4" />
      </button>
    </TooltipHint>
  );
}

export function TabBar() {
  const group = useActiveGroup();
  const moveTab = useTabStore((s) => s.moveTab);
  const activeWorkspaceSlug = useTabStore((s) => s.activeWorkspaceSlug);
  const shouldReduceMotion = useReducedMotion() ?? false;
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const previousTabsRef = useRef<TabSnapshot | null>(null);
  const tabFadeStyle = useScrollFade(
    tabScrollRef,
    TAB_SCROLL_FADE_SIZE,
    "horizontal",
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const tabs = group?.tabs ?? [];
  const activeTabId = group?.activeTabId ?? "";
  const tabIds = tabs.map((t) => t.id);
  const tabOrder = tabIds.join("\0");
  const tabLayoutKey = tabs
    .map((tab) => `${tab.id}:${tab.pinned ? "pinned" : "unpinned"}`)
    .join("\0");
  const addedTabIds = getAddedTabIds(
    previousTabsRef.current,
    activeWorkspaceSlug,
    tabIds,
  );
  const addedTabIdSet = new Set(addedTabIds);
  const newestTabId = addedTabIds.at(-1) ?? null;
  const backgroundAddedTabId =
    newestTabId && newestTabId !== activeTabId ? newestTabId : null;
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const unpinnedCount = tabs.length - pinnedCount;

  useLayoutEffect(() => {
    const currentTabIds = tabOrder ? tabOrder.split("\0") : [];
    const newlyAddedIds = getAddedTabIds(
      previousTabsRef.current,
      activeWorkspaceSlug,
      currentTabIds,
    );
    previousTabsRef.current = {
      workspaceSlug: activeWorkspaceSlug,
      ids: new Set(currentTabIds),
    };

    if (newlyAddedIds.length > 0) {
      if (newlyAddedIds.includes(activeTabId)) {
        keepTabVisible(
          tabScrollRef.current,
          activeTabId,
          shouldReduceMotion ? "auto" : "smooth",
        );
      }
      // Background additions intentionally preserve the user's current tab and
      // scroll position. NewTabEdgeFeedback handles the offscreen acknowledgement.
      return;
    }

    keepTabVisible(tabScrollRef.current);
  }, [
    activeWorkspaceSlug,
    activeTabId,
    shouldReduceMotion,
    tabLayoutKey,
    tabOrder,
  ]);

  useEffect(() => {
    const scroller = tabScrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;

    // Sidebar and window resizing can hide the active tab without changing
    // activeTabId, so keep it visible as the strip's viewport changes.
    const resizeObserver = new ResizeObserver(() => keepTabVisible(scroller));
    resizeObserver.observe(scroller);
    return () => resizeObserver.disconnect();
  }, []);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = tabs.findIndex((t) => t.id === active.id);
    const to = tabs.findIndex((t) => t.id === over.id);
    // The store clamps the destination to within the source tab's zone
    // (pinned vs unpinned), so this call is safe even when the user tries
    // to drag across the boundary — the tab will land at the boundary.
    if (from !== -1 && to !== -1) moveTab(from, to);
  };

  return (
    <div className="flex h-full w-full min-w-0 max-w-full items-center justify-start gap-1 px-3.5">
      <div className="relative flex h-full min-w-0 flex-1 items-center">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          {/* 药丸从顶部条左缘起排，首个标签与下方主区白卡左缘对齐；py-1 给选中
              药丸的阴影留出位置，避免被 overflow 裁掉。 */}
          <div
            ref={tabScrollRef}
            data-tab-scroll-container
            className="no-scrollbar flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden overscroll-x-contain py-1"
            style={tabFadeStyle}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab, index) => {
                const previousTab = index > 0 ? tabs[index - 1] : null;
                return (
                  <Fragment key={tab.id}>
                    <SortableTabItem
                      tab={tab}
                      isActive={tab.id === activeTabId}
                      isOnly={tabs.length === 1}
                      canCloseOthers={tabs.some(
                        (candidate) => candidate.id !== tab.id && !candidate.pinned,
                      )}
                      isNew={addedTabIdSet.has(tab.id)}
                      shouldReduceMotion={shouldReduceMotion}
                      showSeparator={
                        !!previousTab &&
                        tab.id !== activeTabId &&
                        previousTab.id !== activeTabId &&
                        // the pinned-zone divider already separates this pair
                        !(previousTab.pinned && !tab.pinned)
                      }
                    />
                    {tab.pinned &&
                      index === pinnedCount - 1 &&
                      unpinnedCount > 0 && (
                        <div
                          aria-hidden
                          className="mx-1 h-4 w-px shrink-0 self-center bg-surface-border"
                        />
                      )}
                  </Fragment>
                );
              })}
            </SortableContext>
          </div>
        </DndContext>
        <NewTabEdgeFeedback
          newTabId={backgroundAddedTabId}
          scrollerRef={tabScrollRef}
          shouldReduceMotion={shouldReduceMotion}
        />
      </div>
      {group && <NewTabButton />}
    </div>
  );
}
