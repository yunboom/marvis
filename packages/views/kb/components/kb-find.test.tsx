import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { configureShortcutPlatform } from "@marvis/core/shortcuts";
import { renderWithI18n } from "../../test/i18n";
import { KbFindInPage } from "./kb-find";

function Page({ pageId = "page-1" }: { pageId?: string }) {
  const scroller = useRef<HTMLDivElement>(null);

  return (
    <div ref={scroller}>
      <KbFindInPage container={scroller} pageId={pageId} />
      <h1>支付回调</h1>
      <p>渠道回调按订单号去重，重复回调直接返回成功。</p>
    </div>
  );
}

// Flush the frame-deferred match recompute.
async function flushFrames(count = 3) {
  for (let i = 0; i < count; i++) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

const RECT = [{ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }] as unknown as DOMRectList;

describe("KbFindInPage", () => {
  const originalElementRects = Element.prototype.getClientRects;

  beforeEach(() => {
    configureShortcutPlatform("macos");
    // jsdom lays nothing out; the find shortcut only acts on a visible page.
    Element.prototype.getClientRects = () => RECT;
    (Range.prototype as { getClientRects: () => DOMRectList }).getClientRects = () => RECT;
  });

  afterEach(() => {
    configureShortcutPlatform(null);
    Element.prototype.getClientRects = originalElementRects;
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  });

  it("opens on Mod+F, counts matches, steps through them and closes on Escape", async () => {
    renderWithI18n(<Page />, { locale: "zh-Hans" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();

    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    // The browser's own find is replaced.
    expect(event.defaultPrevented).toBe(true);

    const input = await screen.findByRole("textbox", { name: "在页面中查找" });
    await userEvent.type(input, "回调");
    await flushFrames();
    expect(screen.getByText("1/3")).toBeInTheDocument();

    await userEvent.type(input, "{Enter}");
    expect(screen.getByText("2/3")).toBeInTheDocument();
    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("3/3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "下一个" }));
    expect(screen.getByText("1/3")).toBeInTheDocument();

    // Escape from the page, outside the bar, closes it too.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("leaves Mod+Shift+F to the knowledge base search", () => {
    renderWithI18n(<Page />, { locale: "zh-Hans" });

    fireEvent.keyDown(document, { key: "F", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("closes when another page opens", async () => {
    const { rerender } = renderWithI18n(<Page />, { locale: "zh-Hans" });

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    await screen.findByRole("search");

    rerender(<Page pageId="page-2" />);
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });
});
