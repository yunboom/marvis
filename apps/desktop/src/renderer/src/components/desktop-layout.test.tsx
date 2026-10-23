import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import { useSidebar } from "@marvis/ui/components/ui/sidebar";
import { RESOURCES } from "@marvis/views/locales";

// The shell resolves the mocked `getCurrentSlug()` against the workspace list
// before mounting workspace-scoped chrome, so the list has to contain it or
// the sidebar under test never renders. Gating behaviour itself is covered by
// desktop-layout.workspace-gate.test.tsx.
const WORKSPACES = [{ id: "ws-1", slug: "acme" }];

// The shell is the only thing under test here, so everything it mounts around
// the sidebar is stubbed out. What survives is the pair that has to agree:
// `WindowToolbar`'s own trigger, and the `hasExternalTrigger` the provider
// publishes to every page header inside the canvas.
vi.mock("@/hooks/use-tab-history", () => ({
  useTabHistory: () => ({
    canGoBack: false,
    canGoForward: false,
    historyEntries: [],
    historyIndex: 0,
    browsingHistory: [],
    goBack: vi.fn(),
    goForward: vi.fn(),
    goToHistoryIndex: vi.fn(),
  }),
  useNavigationInputBindings: () => {},
}));

vi.mock("@/platform/navigation", () => ({
  DesktopNavigationProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  routeContentLinkPath: vi.fn(),
}));

vi.mock("@marvis/core/paths", () => ({
  WorkspaceSlugProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  paths: { workspace: () => ({ inbox: () => "/acme/inbox" }) },
  useCurrentWorkspace: () => null,
}));

vi.mock("@marvis/core/platform", () => ({
  getCurrentSlug: () => "acme",
  subscribeToCurrentSlug: () => () => {},
}));

vi.mock("@marvis/core/workspace", () => ({
  workspaceListOptions: () => ({
    queryKey: ["workspace-list"],
    queryFn: async () => WORKSPACES,
  }),
}));

vi.mock("@marvis/views/navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

vi.mock("@marvis/views/platform", () => ({
  useDesktopUnreadBadge: () => {},
}));

vi.mock("@marvis/views/layout", () => ({
  AppSidebar: () => null,
  GlobalShortcuts: () => null,
  NavigationProgress: () => null,
}));

vi.mock("@marvis/views/modals/registry", () => ({ ModalRegistry: () => null }));
vi.mock("@marvis/views/search", () => ({
  SearchCommand: () => null,
  SearchTrigger: () => null,
}));
vi.mock("@marvis/views/chat", () => ({ FloatingChat: () => null }));
vi.mock("./tab-bar", () => ({ TabBar: () => null }));
vi.mock("./window-overlay", () => ({ WindowOverlay: () => null }));

const openServerSettingsTab = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-open-settings-shortcut", () => ({ openServerSettingsTab }));

// Stands in for whatever page the active tab is showing. Reports the one fact
// a `PageHeader` reads before deciding to render its own fallback trigger.
vi.mock("./tab-content", () => ({
  TabContent: () => {
    const { hasExternalTrigger, isCompact, setOpen, state } = useSidebar();
    return (
      <div
        data-compact={isCompact}
        data-external-trigger={hasExternalTrigger}
        data-sidebar-state={state}
        data-testid="page-content"
      >
        <button type="button" onClick={() => setOpen(false)}>
          Collapse sidebar
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Expand sidebar
        </button>
      </div>
    );
  },
}));

const { DesktopShell } = await import("./desktop-layout");

function renderShell(server?: Record<string, unknown>) {
  (
    window as unknown as { desktopAPI: Record<string, unknown> }
  ).desktopAPI = {
    onNavigationGesture: () => () => {},
    onInboxOpen: () => () => {},
    onOpenPath: () => () => {},
    ...(server ? { server } : {}),
  };

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  qc.setQueryData(["workspace-list"], WORKSPACES);

  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={RESOURCES}>
        <DesktopShell />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  localStorage.clear();
});

describe("DesktopShell sidebar trigger", () => {
  // The window toolbar parks a trigger beside the traffic lights that never
  // scrolls away, so nothing inside the canvas may add a second one. Desktop
  // windows sit below `xl`, exactly the band where `PageHeader`'s fallback
  // trigger renders, so every page used to stack an identical icon 50px under
  // this one — and a third when a list/detail surface brought its own header
  // along (MUL-6218).
  it("keeps exactly one trigger and tells page headers not to add another", () => {
    const { container, getByTestId, queryByRole } = renderShell();

    expect(container.querySelectorAll("[data-slot='sidebar-trigger']")).toHaveLength(1);
    expect(getByTestId("page-content")).toHaveAttribute(
      "data-external-trigger",
      "true",
    );
    const mainTopBar = container.querySelector('[data-slot="main-top-bar"]');
    expect(mainTopBar).toHaveAttribute("data-sidebar-resize-consumer");
    expect(mainTopBar).toHaveClass("transition-[padding-left]");
    expect(mainTopBar).toHaveStyle({
      paddingLeft:
        "max(0px, calc(200px - var(--sidebar-live-width, var(--sidebar-width))))",
    });

    fireEvent.click(
      container.querySelector('[data-slot="sidebar-trigger"]')!,
    );
    expect(mainTopBar).toHaveStyle({ paddingLeft: "200px" });
    expect(queryByRole("status", { name: /loading workspace/i })).toBeNull();
  });

  it("keeps full clearance for compact layouts in either sidebar state", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });

    const { container, getByRole, getByTestId } = renderShell();
    const mainTopBar = container.querySelector('[data-slot="main-top-bar"]');

    expect(getByTestId("page-content")).toHaveAttribute("data-compact", "true");
    expect(getByTestId("page-content")).toHaveAttribute(
      "data-sidebar-state",
      "expanded",
    );
    expect(mainTopBar).toHaveStyle({ paddingLeft: "200px" });

    fireEvent.click(getByRole("button", { name: "Collapse sidebar" }));
    expect(getByTestId("page-content")).toHaveAttribute(
      "data-sidebar-state",
      "collapsed",
    );
    expect(mainTopBar).toHaveStyle({ paddingLeft: "200px" });

    fireEvent.click(getByRole("button", { name: "Expand sidebar" }));
    expect(getByTestId("page-content")).toHaveAttribute(
      "data-sidebar-state",
      "expanded",
    );
    expect(mainTopBar).toHaveStyle({ paddingLeft: "200px" });
  });
});


describe("DesktopShell server status", () => {
  const saved = {
    url: "http://192.168.1.20:13840",
    name: "Design Marvis",
    instanceId: "inst-design",
    source: "lan",
    appUrl: "",
  };

  // 推送主进程的连接状态；renderShell 里的 I18nProvider 是英文。
  function renderWithServer() {
    let push: (status: unknown) => void = () => {};
    const retry = vi.fn();
    const view = renderShell({
      onStatus: (callback: (status: unknown) => void) => {
        push = callback;
        return () => {};
      },
      current: async () => saved,
      retry,
    });

    return { ...view, retry, push: (status: unknown) => act(() => push(status)) };
  }

  const dimmedContent = () =>
    document.querySelector('[data-slot="main-canvas-content"]') as HTMLElement;

  beforeEach(() => {
    openServerSettingsTab.mockReset();
  });

  it("shows no banner and does not dim the page while online", async () => {
    const { push } = renderWithServer();
    await act(async () => {});

    expect(screen.queryByRole("status", { name: /./ })).toBeNull();
    expect(document.querySelector('[data-slot="server-status-banner"]')).toBeNull();

    push({ state: "online" });
    expect(document.querySelector('[data-slot="server-status-banner"]')).toBeNull();
    expect(dimmedContent()).not.toHaveClass("opacity-55");
  });

  it("puts the banner above the page content inside the main card and dims the content", async () => {
    const { push } = renderWithServer();
    await act(async () => {});

    push({ state: "reconnecting" });

    const banner = document.querySelector('[data-slot="server-status-banner"]') as HTMLElement;
    expect(banner).toHaveTextContent("Lost connection to Design Marvis. Reconnecting…");

    const canvas = document.querySelector('[data-slot="main-canvas"]') as HTMLElement;
    expect(canvas.firstElementChild).toBe(banner);
    expect(dimmedContent()).toHaveClass("opacity-55");
    expect(dimmedContent().querySelector('[data-testid="page-content"]')).not.toBeNull();

    push({ state: "online" });
    expect(document.querySelector('[data-slot="server-status-banner"]')).toBeNull();
    expect(dimmedContent()).not.toHaveClass("opacity-55");
  });

  it("retries and opens the server settings from the unreachable banner", async () => {
    const { push, retry } = renderWithServer();
    await act(async () => {});

    push({ state: "unreachable" });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Switch server" }));
    expect(openServerSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("asks before anything changes when another server answers at the saved address", async () => {
    const { push } = renderWithServer();
    await act(async () => {});

    push({ state: "replaced", otherName: "Test env" });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("A different server is at this address");
    expect(dialog).toHaveTextContent("192.168.1.20:13840 is now “Test env”");
    expect(document.querySelector('[data-slot="server-status-banner"]')).not.toBeNull();

    // 继续等待：只关弹窗，横幅仍在。
    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    await act(async () => {});
    expect(document.querySelector('[data-slot="server-status-banner"]')).not.toBeNull();
    expect(openServerSettingsTab).not.toHaveBeenCalled();
  });

  it("switching from the replaced dialog closes it and opens the server settings", async () => {
    const { push } = renderWithServer();
    await act(async () => {});

    push({ state: "replaced", otherName: "Test env" });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Switch server" }));
    await act(async () => {});

    expect(openServerSettingsTab).toHaveBeenCalledTimes(1);
  });
});
