// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useTabStore } from "@/stores/tab-store";
import { useWindowOverlayStore } from "@/stores/window-overlay-store";
import {
  openServerSettingsTab,
  openSettingsTab,
  useOpenSettingsShortcut,
} from "./use-open-settings-shortcut";

function Probe() {
  useOpenSettingsShortcut();
  return null;
}

/** One workspace with a single issues tab open. */
function seedTabs() {
  useTabStore.setState({
    activeWorkspaceSlug: "acme",
    byWorkspace: {
      acme: {
        tabs: [
          {
            id: "t1",
            url: "/acme/issues",
            resourceKey: "/acme/issues",
            title: "",
            pinned: false,
            history: { stack: ["/acme/issues"], index: 0 },
            memento: { scroll: {}, view: {} },
          },
        ],
        activeTabId: "t1",
        recentTabIds: ["t1"],
        browsingHistory: ["/acme/issues"],
        browsingHistoryTitles: {},
      },
    },
  });
}

function tabUrls(): string[] {
  return useTabStore.getState().byWorkspace.acme?.tabs.map((t) => t.url) ?? [];
}

function activeTabUrl(): string | undefined {
  const group = useTabStore.getState().byWorkspace.acme;
  return group?.tabs.find((t) => t.id === group.activeTabId)?.url;
}

/** Installs a desktopAPI stub; `deliver()` plays the chord main would send. */
function stubDesktopAPI(kind: "main" | "issue") {
  let handler: (() => void) | null = null;
  const onOpenSettings = vi.fn((callback: () => void) => {
    handler = callback;
    return () => {
      handler = null;
    };
  });
  (window as unknown as { desktopAPI: Record<string, unknown> }).desktopAPI = {
    windowContext:
      kind === "main"
        ? { kind: "main" }
        : { kind: "issue", path: "/acme/issues/abc", workspaceSlug: "acme" },
    onOpenSettings,
  };
  return { onOpenSettings, deliver: () => handler?.() };
}

describe("openSettingsTab", () => {
  beforeEach(() => {
    seedTabs();
    useWindowOverlayStore.setState({ overlay: null });
  });

  it("opens Settings for the active workspace and focuses it", () => {
    openSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues", "/acme/settings"]);
    expect(activeTabUrl()).toBe("/acme/settings");
  });

  it("reuses the Settings tab instead of stacking duplicates", () => {
    openSettingsTab();
    useTabStore.getState().setActiveTab("t1");
    openSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues", "/acme/settings"]);
    expect(activeTabUrl()).toBe("/acme/settings");
  });

  it("does nothing while a pre-workspace overlay covers the window", () => {
    useWindowOverlayStore.setState({ overlay: { type: "onboarding" } });

    openSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues"]);
  });

  it("does nothing without an active workspace (logged out)", () => {
    useTabStore.setState({ activeWorkspaceSlug: null });

    expect(() => openSettingsTab()).not.toThrow();
    expect(tabUrls()).toEqual(["/acme/issues"]);
  });
});

describe("openServerSettingsTab", () => {
  beforeEach(() => {
    seedTabs();
    useWindowOverlayStore.setState({ overlay: null });
  });

  it("opens Settings on the server tab", () => {
    openServerSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues", "/acme/settings?tab=server"]);
    expect(activeTabUrl()).toBe("/acme/settings?tab=server");
  });

  // openTab only focuses an existing Settings tab and keeps its own url, so
  // a Settings tab sitting on another section has to be moved explicitly.
  it("moves an already open Settings tab to the server tab", () => {
    useTabStore.getState().openTab("/acme/settings?tab=profile", "", { activate: true });

    openServerSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues", "/acme/settings?tab=server"]);
    expect(activeTabUrl()).toBe("/acme/settings?tab=server");
  });

  it("does not stack duplicates when called twice", () => {
    openServerSettingsTab();
    openServerSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues", "/acme/settings?tab=server"]);
  });

  it("does nothing while a pre-workspace overlay covers the window", () => {
    useWindowOverlayStore.setState({ overlay: { type: "onboarding" } });

    openServerSettingsTab();

    expect(tabUrls()).toEqual(["/acme/issues"]);
  });

  it("does nothing without an active workspace", () => {
    useTabStore.setState({ activeWorkspaceSlug: null });

    expect(() => openServerSettingsTab()).not.toThrow();
    expect(tabUrls()).toEqual(["/acme/issues"]);
  });
});

describe("useOpenSettingsShortcut", () => {
  beforeEach(() => {
    seedTabs();
    useWindowOverlayStore.setState({ overlay: null });
  });

  it("opens Settings when main delivers the chord", () => {
    const { deliver } = stubDesktopAPI("main");
    render(<Probe />);

    deliver();

    expect(activeTabUrl()).toBe("/acme/settings");
  });

  // Main routes the chord to the tabbed window; an issue renderer that also
  // subscribed would mark the channel ready and drain the request into a
  // window that has no tabs to open it in.
  it("does not subscribe in a dedicated issue window", () => {
    const { onOpenSettings } = stubDesktopAPI("issue");

    render(<Probe />);

    expect(onOpenSettings).not.toHaveBeenCalled();
  });
});
