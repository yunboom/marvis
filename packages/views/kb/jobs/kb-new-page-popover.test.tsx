import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbNewPagePopover } from "./kb-new-page-popover";

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

describe("KbNewPagePopover", () => {
  it("opens a new-page job under the row's page with the request written out (designs 4.1–4.3)", async () => {
    const adapter: NavigationAdapter = {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      pathname: "/acme/kb/team/p/page-pay",
      searchParams: new URLSearchParams(),
      hash: "",
      getShareableUrl: (path) => path,
    };
    renderWithI18n(
      <NavigationProvider value={adapter}>
        <KbNewPagePopover kbSlug="team" parentId="page-pay" parentTitle="支付" />
      </NavigationProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Ask an agent to write a page here" }));
    expect(await screen.findByText("Write a page under 支付")).toBeInTheDocument();
    const handOff = screen.getByRole("button", { name: "Hand to an agent" });
    expect(handOff).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "What to write" }), "回调人工处理的操作步骤");
    await userEvent.click(handOff);

    const target = new URL(vi.mocked(adapter.push).mock.calls[0]![0], "https://app.example");
    expect(target.pathname).toBe("/acme/kb/team/jobs/new");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      starter: "new_page",
      page: "page-pay",
      message: "Add a page under “支付”: 回调人工处理的操作步骤",
    });
  });
});
