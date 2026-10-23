import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@marvis/ui/lib/utils";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { openServerSettingsTab } from "@/hooks/use-open-settings-shortcut";
import {
  useNavigationInputBindings,
  useTabHistory,
} from "@/hooks/use-tab-history";
import {
  SidebarProvider,
  useSidebar,
} from "@marvis/ui/components/ui/sidebar";
import { ModalRegistry } from "@marvis/views/modals/registry";
import {
  AppSidebar,
  CurrentWorkspaceLarkInviteWelcome,
  GlobalShortcuts,
  NavigationProgress,
} from "@marvis/views/layout";
import { SearchCommand, SearchTrigger } from "@marvis/views/search";
import { FloatingChat } from "@marvis/views/chat";
import { WorkspaceSlugProvider, paths, useCurrentWorkspace } from "@marvis/core/paths";
import { workspaceListOptions } from "@marvis/core/workspace";
import {
  useNavigation,
  type LinkClickIntent,
} from "@marvis/views/navigation";
import { getCurrentSlug, subscribeToCurrentSlug } from "@marvis/core/platform";
import { useDesktopUnreadBadge } from "@marvis/views/platform";
import { useT } from "@marvis/views/i18n";
import {
  DesktopNavigationProvider,
  routeContentLinkPath,
} from "@/platform/navigation";
import { OpenPathBridge } from "@/platform/open-path-bridge";
import {
  ServerReplacedDialog,
  ServerStatusBanner,
} from "./server/server-status-banner";
import { useServerStatus } from "./server/use-server-status";
import { TabBar } from "./tab-bar";
import { TabContent } from "./tab-content";
import { WindowOverlay } from "./window-overlay";
import { WindowToolbar, WINDOW_TOOLBAR_CLEARANCE } from "./window-toolbar";

// 顶部条高度：红绿灯（trafficLightPosition y=13）、前进后退和标签栏都在这一条里
// 垂直居中；侧栏浮卡与主区白卡从它下方开始，顶边对齐（globals.css 里侧栏容器的
// padding-top 与此保持一致）。
const TOP_BAR_HEIGHT_CLASS = "h-10";

function useNativeNavigationGestures() {
  const { goBack, goForward } = useTabHistory();

  useEffect(() => {
    return window.desktopAPI.onNavigationGesture((gesture) => {
      if (gesture === "back") {
        goBack();
      } else {
        goForward();
      }
    });
  }, [goBack, goForward]);
}


// The main area's top bar doubles as a window drag region. When the sidebar
// is not occupying enough main-flow width, leave the remainder here so tabs
// do not land beneath the traffic lights / navigation controls. The matching
// 200ms transition cancels the sidebar gap's movement during toggle; live
// resize previews disable it through data-sidebar-resize-consumer.
function MainTopBar({ sidebarMounted }: { sidebarMounted: boolean }) {
  const { state, isCompact } = useSidebar();
  const sidebarHidden = !sidebarMounted || state === "collapsed" || isCompact;
  const toolbarClearance: React.CSSProperties["paddingLeft"] = sidebarHidden
    ? WINDOW_TOOLBAR_CLEARANCE
    : `max(0px, calc(${WINDOW_TOOLBAR_CLEARANCE}px - var(--sidebar-live-width, var(--sidebar-width))))`;

  return (
    <header
      data-slot="main-top-bar"
      data-sidebar-resize-consumer
      className={cn(
        "relative shrink-0 flex items-center gap-2 transition-[padding-left] duration-(--motion-base) ease-standard motion-reduce:transition-none",
        TOP_BAR_HEIGHT_CLASS,
      )}
      style={{ paddingLeft: toolbarClearance }}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 right-0"
        style={
          {
            left: toolbarClearance,
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      />
      <div
        data-slot="main-top-bar-content"
        className="relative z-10 flex h-full min-w-0 max-w-full items-center"
      >
        <TabBar />
      </div>
    </header>
  );
}

// 主区白卡：与侧栏浮卡同样的 16px 外壳留白、24 圆角、细描边。侧栏的 sidebar-gap
// 已把 16px 外壳留白放在浮卡左侧，所以无论侧栏展开还是收起，白卡左侧都是 16px。
// banner 是服务器连接状态横幅，贴在卡片顶部、页面内容之上；dimmed 时页面内容变淡，
// 说明数据可能不是最新的（仍可阅读和操作）。
function MainCanvas({
  children,
  showWorkspaceLoading,
  banner,
  dimmed,
}: {
  children: React.ReactNode;
  showWorkspaceLoading: boolean;
  banner: React.ReactNode;
  dimmed: boolean;
}) {
  const { t } = useT("layout");
  const loadingLabel = t(($) => $.workspace_loader.loading_workspace);

  return (
    <div
      data-slot="main-canvas"
      className="relative mx-4 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-page-canvas"
    >
      {banner}
      <div
        data-slot="main-canvas-content"
        className={cn(
          "relative flex min-h-0 flex-1 flex-col transition-opacity duration-(--motion-base) motion-reduce:transition-none",
          dimmed && "opacity-55",
        )}
      >
        {children}
      </div>
      {showWorkspaceLoading && (
        <div
          aria-label={loadingLabel}
          aria-live="polite"
          className="absolute inset-0 z-20 flex items-center justify-center bg-page-canvas"
          role="status"
        >
          <div className="flex flex-col items-center gap-4">
            <MarvisIcon className="size-12 animate-pulse" />
            <p className="text-body text-muted-foreground">{loadingLabel}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function useInternalLinkHandler() {
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ path?: string; disposition?: LinkClickIntent }>
      ).detail;
      if (!detail?.path) return;
      routeContentLinkPath(detail.path, detail.disposition);
    };
    window.addEventListener("marvis:navigate", handler);
    return () => window.removeEventListener("marvis:navigate", handler);
  }, []);
}

/**
 * Bridge between the renderer and the Electron main process for inbox-level
 * OS integration. Mounted inside WorkspaceSlugProvider so it can resolve the
 * current workspace's id for the badge hook.
 *
 * Two responsibilities:
 *   1. Mirror the unread inbox count onto the dock/taskbar badge.
 *   2. When the user clicks an OS notification, open the notified
 *      workspace's inbox focused on that item. The route uses the `slug`
 *      that the notification was *emitted* with — not the currently active
 *      workspace — so a notification from workspace A always opens A's
 *      inbox even if the user has since switched to workspace B. Marking
 *      the row read is handled by InboxPage's selected-item effect, which
 *      covers both click-to-select and URL-param-select paths.
 *
 * The click routes through `useNavigation().push` — NOT the
 * `marvis:navigate` event, whose handler `openTab`s into the ACTIVE
 * workspace's tab group. The navigation adapter detects a cross-workspace
 * path and translates it into `switchWorkspace(slug, path)`, so clicking a
 * workspace-A notification while B is active performs a real workspace
 * switch instead of mounting A's inbox inside B's tab group (#3766).
 */
function DesktopInboxBridge() {
  const workspace = useCurrentWorkspace();
  useDesktopUnreadBadge(workspace?.id ?? null);
  const { push } = useNavigation();
  // The adapter identity changes with the active tab's location; the ref
  // keeps the main-process subscription stable across navigations.
  const pushRef = useRef(push);
  useEffect(() => {
    pushRef.current = push;
  }, [push]);

  useEffect(() => {
    return window.desktopAPI.onInboxOpen(({ slug, issueKey }) => {
      if (!slug) return;
      const inboxPath = `${paths.workspace(slug).inbox()}?issue=${encodeURIComponent(issueKey)}`;
      pushRef.current(inboxPath);
    });
  }, []);

  return null;
}

export function DesktopShell() {
  useInternalLinkHandler();
  useNativeNavigationGestures();
  useNavigationInputBindings();
  const serverStatus = useServerStatus();

  // Reactive read of current workspace slug from the platform singleton.
  // On first mount, it is null until WorkspaceRouteLayout (inside the tab
  // router) sets it. Once set, the sidebar and other shell-level components
  // can resolve workspace-scoped paths via useWorkspacePaths().
  const currentSlug = useSyncExternalStore(
    subscribeToCurrentSlug,
    getCurrentSlug,
    () => null,
  );
  // Chrome gates on "the slug still resolves to a workspace", NOT on "the
  // singleton is non-null" (MUL-6231 / #7021). The singleton is mutable
  // process state that no single owner keeps in lockstep with the workspace
  // list, so after the active workspace is deleted it can still hold the dead
  // slug for a beat. Everything below mounts workspace-scoped components —
  // SearchCommand calls useWorkspaceId(), which THROWS when the workspace is
  // gone from the list. Nothing above this in the desktop tree is an error
  // boundary, so that throw used to unmount the whole renderer and leave a
  // blank, unresponsive window.
  //
  // Deriving from the list cache makes this the same gate web uses
  // (DashboardGuard's `!workspace` check in packages/views/layout), so both
  // shells drop workspace-scoped chrome on exactly the same signal instead of
  // diverging. TabContent stays outside the gate: it must always render so
  // the tab router can mount WorkspaceRouteLayout, which is what populates
  // the singleton in the first place.
  const { data: workspaces = [] } = useQuery(workspaceListOptions());
  const slug =
    currentSlug && workspaces.some((w) => w.slug === currentSlug)
      ? currentSlug
      : null;

  return (
    <DesktopNavigationProvider>
      {/* WorkspaceSlugProvider accepts null — components that need slug
          use useWorkspaceSlug() (nullable) or useRequiredWorkspaceSlug()
          (throws). TabContent MUST always render so the tab router can
          mount WorkspaceRouteLayout, which calls setCurrentWorkspace()
          to populate the slug. The sidebar gates on the resolved slug
          (see above) to avoid the useRequiredWorkspaceSlug and
          useWorkspaceId throws. Zero-workspace users see the
          window-level overlay (new-workspace flow) triggered by
          IndexRedirect, not a route. */}
      <WorkspaceSlugProvider slug={slug}>
        <DesktopInboxBridge />
        <OpenPathBridge />
        <div className="flex h-screen bg-app-shell">
          {/* bg-app-shell is the wrapper's non-inset fill, so it also owns the
              non-inset half of --sidebar-wrapper-fill. sidebar.tsx supplies the
              inset half of both. Anything that has to paint an opaque layer
              over this wrapper (the tab flares) reads the variable rather than
              re-deriving which of the two is in play. */}
          {/* hasExternalTrigger: WindowToolbar below parks a SidebarTrigger
              beside the traffic lights, where it is always reachable. Page
              headers inside the canvas must not add their own fallback one on
              top of it — desktop windows sit below `xl`, exactly where that
              fallback renders, so every page showed a second identical icon
              50px under this one (MUL-6218). */}
          <SidebarProvider
            hasExternalTrigger
            className="flex-1 bg-app-shell [--sidebar-wrapper-fill:var(--app-shell)]"
          >
            {slug && <GlobalShortcuts />}
            {/* One-time "joined via Feishu invite" toast. The shell outlives tab
                switches, so mounting it here (not per tab) shows it once per
                session; web mounts the same component in DashboardLayout. */}
            {slug && <CurrentWorkspaceLarkInviteWelcome />}
            {slug && <WindowToolbar />}
            {slug && <AppSidebar searchSlot={<SearchTrigger />} />}
            {/* Right side: header + content container */}
            <div className="flex flex-1 min-w-0 flex-col">
              <MainTopBar sidebarMounted={Boolean(slug)} />
              <MainCanvas
                showWorkspaceLoading={!slug}
                dimmed={serverStatus.banner !== null}
                banner={
                  serverStatus.banner !== null && (
                    <ServerStatusBanner
                      state={serverStatus.banner}
                      server={serverStatus.server}
                      onRetry={serverStatus.retry}
                      onSwitch={openServerSettingsTab}
                    />
                  )
                }
              >
                {/* Same indicator, same anchor as web: DashboardLayout puts it
                    at the top of SidebarInset, and MainCanvas is desktop's
                    equivalent relative/overflow-hidden content box. Desktop
                    used to have no navigation feedback at all — a click just
                    froze until the destination committed (MUL-6404). */}
                <NavigationProgress />
                <TabContent />
                {slug && <FloatingChat />}
              </MainCanvas>
            </div>
          </SidebarProvider>
        </div>
        {slug && <ModalRegistry />}
        {slug && <SearchCommand />}
        <WindowOverlay />
        <ServerReplacedDialog
          open={serverStatus.replaced.open}
          server={serverStatus.server}
          otherName={serverStatus.replaced.otherName}
          onWait={serverStatus.dismissReplaced}
          onSwitch={() => {
            serverStatus.dismissReplaced();
            openServerSettingsTab();
          }}
        />
      </WorkspaceSlugProvider>
    </DesktopNavigationProvider>
  );
}
