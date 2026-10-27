import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";

// The rich renderer is beside the point here; the fold only measures height.
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { CollapsibleInstructions } from "./collapsible-instructions";

// jsdom does no layout, so scrollHeight is 0 unless a test says otherwise.
function stubContentHeight(px: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(px);
}

describe("CollapsibleInstructions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows short instructions whole, with no toggle", () => {
    stubContentHeight(60);
    renderWithI18n(<CollapsibleInstructions content="Check the ledger." />);

    expect(screen.getByText("Check the ledger.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("folds long instructions until the reader expands them, and folds them back", async () => {
    stubContentHeight(400);
    const user = userEvent.setup();
    renderWithI18n(<CollapsibleInstructions content="A long prompt" />);

    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region).toHaveClass("max-h-32");

    await user.click(toggle);

    const collapse = screen.getByRole("button", { name: "Show less" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(region).not.toHaveClass("max-h-32");

    await user.click(collapse);

    expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute("aria-expanded", "false");
    expect(region).toHaveClass("max-h-32");
  });

  it("reads the toggle in the reader's language", () => {
    stubContentHeight(400);
    renderWithI18n(<CollapsibleInstructions content="长指令" />, { locale: "zh-Hans" });

    expect(screen.getByRole("button", { name: "显示全部" })).toBeInTheDocument();
  });
});
