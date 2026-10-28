import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageBoxStore } from "@marvis/core/inbox/message-box-store";
import { renderWithI18n } from "../../test/i18n";
import { MessageBox } from "./message-box";

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/acme/issues" }),
}));

vi.mock("./inbox-page", () => ({
  MESSAGE_BOX_LAYER_ATTR: "data-message-box",
  InboxPage: () => (
    <>
      <button type="button">row</button>
      <a
        href="/acme/issues"
        onClick={(e) => e.preventDefault()}
      >
        same page link
      </a>
    </>
  ),
}));

describe("MessageBox", () => {
  beforeEach(() => {
    act(() => useMessageBoxStore.getState().setOpen(true));
  });

  it("closes on Escape", async () => {
    renderWithI18n(<MessageBox />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(useMessageBoxStore.getState().open).toBe(false);
  });

  // The box otherwise closes on a pathname change, which a link to the page it
  // was opened over never makes ("go review" while that review is behind it).
  it("closes when a link inside is followed, even to the page behind it", async () => {
    renderWithI18n(<MessageBox />);

    fireEvent.click(await screen.findByRole("link", { name: "same page link" }));

    expect(useMessageBoxStore.getState().open).toBe(false);
  });

  it("stays open when a link is opened in a new tab", async () => {
    renderWithI18n(<MessageBox />);

    fireEvent.click(await screen.findByRole("link", { name: "same page link" }), { metaKey: true });

    expect(useMessageBoxStore.getState().open).toBe(true);
  });
});
