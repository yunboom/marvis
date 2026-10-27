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
  InboxPage: () => <button type="button">row</button>,
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
});
