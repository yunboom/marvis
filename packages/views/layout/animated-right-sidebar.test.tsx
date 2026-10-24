import { act, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureShortcutPlatform,
  useShortcutStore,
} from "@marvis/core/shortcuts";

import {
  getAnimatedRightSidebarInitialOpen,
  RightSidebarOpenState,
  useRightSidebarController,
  useRightSidebarState,
  useRightSidebarShortcut,
} from "./animated-right-sidebar";

afterEach(() => {
  configureShortcutPlatform(null);
  useShortcutStore.getState().resetAll();
});

function renderSidebarState(initialOpen: boolean) {
  return renderHook(() => {
    const controller = useRightSidebarController(initialOpen);
    return { ...useRightSidebarState(controller), controller };
  });
}

describe("animated right sidebar state", () => {
  // The owner is a whole detail page; a toggle must re-render only the
  // subscribers, or every click re-renders the page and the motion stutters.
  it("re-renders the subscribers on toggle, not the owner", () => {
    let ownerRenders = 0;
    let toggleOpen: boolean | null = null;
    let controller: ReturnType<typeof useRightSidebarController> | null = null;
    function Owner() {
      ownerRenders += 1;
      controller = useRightSidebarController(false);
      return (
        <RightSidebarOpenState controller={controller}>
          {(open) => {
            toggleOpen = open;
            return null;
          }}
        </RightSidebarOpenState>
      );
    }
    render(<Owner />);

    act(() => {
      controller!.beginToggle(true);
    });

    expect(toggleOpen).toBe(true);
    expect(ownerRenders).toBe(1);
  });

  it("uses a restored collapsed layout before falling back to the default", () => {
    expect(
      getAnimatedRightSidebarInitialOpen(true, {
        content: 100,
        sidebar: 0,
      }),
    ).toBe(false);
  });

  it("uses a restored expanded layout before falling back to the default", () => {
    expect(
      getAnimatedRightSidebarInitialOpen(false, {
        content: 70,
        sidebar: 30,
      }),
    ).toBe(true);
  });

  it("falls back to the caller default when no sidebar layout was restored", () => {
    expect(getAnimatedRightSidebarInitialOpen(true, undefined)).toBe(true);
    expect(getAnimatedRightSidebarInitialOpen(false, { content: 100 })).toBe(false);
  });

  it("treats a non-zero layout percentage as open even before pixels are measured", () => {
    const { result } = renderSidebarState(false);

    act(() => {
      result.current.controller.handleResize({
        asPercentage: 30,
        inPixels: 0,
      });
    });

    expect(result.current.open).toBe(true);
    expect(result.current.visualOpen).toBe(true);
    expect(result.current.motionEnabled).toBe(false);
  });

  it("enables motion only for an explicit toggle window", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderSidebarState(false);

      expect(result.current.motionEnabled).toBe(false);

      act(() => {
        result.current.controller.beginToggle(true);
      });

      expect(result.current.open).toBe(true);
      expect(result.current.visualOpen).toBe(true);
      expect(result.current.motionEnabled).toBe(true);

      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.motionEnabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("right sidebar shortcut", () => {
  it("toggles the visible detail sidebar on Mod+/", () => {
    configureShortcutPlatform("macos");
    const onToggle = vi.fn();
    const target = document.createElement("div");
    vi.spyOn(target, "getClientRects").mockReturnValue(
      [{}] as unknown as DOMRectList,
    );
    const targetRef = { current: target };
    const { unmount } = renderHook(() =>
      useRightSidebarShortcut(targetRef, onToggle),
    );
    const event = new KeyboardEvent("keydown", {
      key: "/",
      metaKey: true,
      cancelable: true,
    });

    document.dispatchEvent(event);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    unmount();
  });

  it("leaves the shortcut unclaimed when its detail page is hidden", () => {
    configureShortcutPlatform("macos");
    const onToggle = vi.fn();
    const target = document.createElement("div");
    const targetRef = { current: target };
    const { unmount } = renderHook(() =>
      useRightSidebarShortcut(targetRef, onToggle),
    );
    const event = new KeyboardEvent("keydown", {
      key: "/",
      metaKey: true,
      cancelable: true,
    });

    document.dispatchEvent(event);

    expect(onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    unmount();
  });
});
