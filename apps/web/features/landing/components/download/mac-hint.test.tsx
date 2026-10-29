import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MacHintTrigger } from "./mac-hint";

vi.mock("../../i18n", () => ({
  useLocale: () => ({
    t: {
      download: {
        macHint: {
          trigger: "First launch on Mac",
          title: "Opening on a Mac for the first time",
          sub: "The installer isn't signed by Apple.",
          stepInstall: "Open the .dmg.",
          stepCommand: "Run in Terminal:",
          stepReopen: "Open Marvis again.",
          altSettings: "Or use System Settings.",
          noAutoUpdate: "Automatic updates aren't available yet.",
          copyLabel: "Copy",
          copiedLabel: "Copied",
          close: "Close",
          confirm: "Got it",
        },
      },
    },
  }),
}));

describe("MacHintTrigger", () => {
  it("calls out the missing auto-update as its own warning, apart from the footer note", async () => {
    render(<MacHintTrigger />);

    await userEvent.click(screen.getByRole("button", { name: /First launch on Mac/ }));

    const warning = await screen.findByTestId("mac-hint-no-auto-update");
    expect(warning).toHaveTextContent("Automatic updates aren't available yet.");
    expect(warning).not.toHaveTextContent("Or use System Settings.");
  });
});
