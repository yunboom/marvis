import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@marvis/views/navigation";
import { OpenPathBridge } from "./open-path-bridge";

const unsubscribe = vi.fn();
let deliver: ((path: string) => void) | null = null;
const onOpenPath = vi.fn((callback: (path: string) => void) => {
  deliver = callback;
  return unsubscribe;
});

beforeEach(() => {
  unsubscribe.mockClear();
  onOpenPath.mockClear();
  deliver = null;
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: { onOpenPath },
  });
});

function adapterWith(push: (path: string) => void): NavigationAdapter {
  return {
    push,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => path,
  };
}

function bridgeWith(push: (path: string) => void) {
  return (
    <NavigationProvider value={adapterWith(push)}>
      <OpenPathBridge />
    </NavigationProvider>
  );
}

describe("OpenPathBridge", () => {
  it("navigates to a path delivered by the main process", () => {
    const push = vi.fn();
    render(bridgeWith(push));

    act(() => deliver!("/dev/issues/DEV-1"));

    expect(push).toHaveBeenCalledExactlyOnceWith("/dev/issues/DEV-1");
  });

  it("uses the current adapter without resubscribing when navigation changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(bridgeWith(first));

    rerender(bridgeWith(second));
    act(() => deliver!("/dev/inbox"));

    expect(onOpenPath).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("/dev/inbox");
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = render(bridgeWith(vi.fn()));

    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
