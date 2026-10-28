import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageBoxStore } from "@marvis/core/inbox/message-box-store";
import { Button } from "@marvis/ui/components/ui/button";
import { renderWithI18n } from "../../test/i18n";
import { AppLink, NavigationProvider, type NavigationAdapter } from "../../navigation";
import { MessageBox } from "./message-box";

const REVIEW_PATH = "/acme/kb/team/reviews/6";

// The notice's primary action, composed the way KbReviewNoticeAction does it.
vi.mock("./inbox-page", () => ({
  MESSAGE_BOX_LAYER_ATTR: "data-message-box",
  InboxPage: () => (
    <>
      <button type="button">row</button>
      <Button render={<AppLink href={REVIEW_PATH} />} nativeButton={false}>
        go review
      </Button>
    </>
  ),
}));

/**
 * Mirrors the platform adapters: desktop renders AppLink with the web URL as
 * its href and drops a push to the active tab's own path; web keeps the
 * route-relative href.
 */
function adapter(platform: "desktop" | "web", pathname: string, push = vi.fn()): NavigationAdapter {
  const base = {
    push: (path: string) => {
      if (path === pathname) return;
      push(path);
    },
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(),
    hash: "",
  };
  if (platform === "web") return { ...base, getShareableUrl: (path) => `https://marvis.ai${path}` };

  return {
    ...base,
    openInNewTab: vi.fn(),
    getShareableUrl: (path) => `https://marvis.ai${path}`,
  };
}

function renderBox(value: NavigationAdapter) {
  return renderWithI18n(
    <NavigationProvider value={value}>
      <MessageBox />
    </NavigationProvider>,
  );
}

describe("MessageBox", () => {
  beforeEach(() => {
    act(() => useMessageBoxStore.getState().setOpen(true));
  });

  it("closes on Escape", async () => {
    renderBox(adapter("web", "/acme/issues"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(useMessageBoxStore.getState().open).toBe(false);
  });

  // The box otherwise closes on a pathname change, which a link to the page it
  // was opened over never makes ("go review" while that review is behind it).
  it.each(["desktop", "web"] as const)(
    "closes on %s when a link inside is followed to the page behind it",
    async (platform) => {
      renderBox(adapter(platform, REVIEW_PATH));

      fireEvent.click(await screen.findByRole("button", { name: "go review" }));

      expect(useMessageBoxStore.getState().open).toBe(false);
    },
  );

  it.each(["desktop", "web"] as const)(
    "closes on %s and navigates when a link inside leads elsewhere",
    async (platform) => {
      const push = vi.fn();
      renderBox(adapter(platform, "/acme/kb/team", push));

      fireEvent.click(await screen.findByRole("button", { name: "go review" }));

      expect(push).toHaveBeenCalledWith(REVIEW_PATH);
      expect(useMessageBoxStore.getState().open).toBe(false);
    },
  );

  it.each(["desktop", "web"] as const)("stays open on %s when a link is opened in a new tab", async (platform) => {
    renderBox(adapter(platform, REVIEW_PATH));

    fireEvent.click(await screen.findByRole("button", { name: "go review" }), { metaKey: true });

    expect(useMessageBoxStore.getState().open).toBe(true);
  });
});
