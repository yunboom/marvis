import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createLandingDict } from "../../i18n/dictionary";
import { ReleasesList } from "./releases-list";

vi.mock("../../i18n", () => ({
  useLocale: () => ({ t: createLandingDict("en", true), locale: "en" }),
}));
vi.mock("../landing-header", () => ({ LandingHeader: () => null }));

const releases = [
  {
    version: "v0.0.2",
    publishedAt: "2026-10-30T10:00:00Z",
    assets: { winX64Exe: "https://downloads.test/win.exe" },
  },
  {
    version: "v0.0.1",
    publishedAt: "2026-10-28T10:00:00Z",
    assets: { linuxAmd64Deb: "https://downloads.test/linux.deb" },
  },
];

describe("ReleasesList", () => {
  it("opens the newest release and toggles another one in its place", async () => {
    const user = userEvent.setup();
    render(<ReleasesList releases={releases} />);

    expect(screen.getByRole("link", { name: ".exe" })).toHaveAttribute(
      "href",
      "https://downloads.test/win.exe",
    );
    expect(screen.queryByRole("link", { name: ".deb" })).toBeNull();
    expect(screen.getAllByText("Latest")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /v0\.0\.1/ }));

    expect(screen.getByRole("link", { name: ".deb" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: ".exe" })).toBeNull();
  });

  it("links each version to its in-site detail page", () => {
    render(<ReleasesList releases={releases} />);

    const notes = screen.getAllByRole("link", { name: /Release notes/ });
    expect(notes[1]).toHaveAttribute("href", "/download/releases/v0.0.1");
  });
});
