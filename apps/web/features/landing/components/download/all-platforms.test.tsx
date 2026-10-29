import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AllPlatforms } from "./all-platforms";

vi.mock("../../i18n", () => ({
  useLocale: () => ({
    t: {
      download: {
        allPlatforms: {
          title: "All platforms",
          macArm64Label: "macOS · Apple Silicon",
          macX64Label: "macOS · Intel",
          winX64Label: "Windows · x64",
          winArm64Label: "Windows · ARM64",
          linuxX64Label: "Linux · x64",
          linuxArm64Label: "Linux · ARM64",
          formatDmg: ".dmg",
          formatZip: ".zip",
          formatExe: ".exe",
          formatAppImage: ".AppImage",
          formatDeb: ".deb",
          formatRpm: ".rpm",
          unavailable: "Not available",
        },
        footer: { allReleases: "View all releases" },
        macHint: { trigger: "First launch on Mac" },
      },
    },
  }),
}));

describe("AllPlatforms", () => {
  it("lists Intel macOS downloads separately from Apple Silicon", () => {
    render(
      <AllPlatforms
        assets={{
          macArm64Dmg: "https://downloads.test/mac-arm64.dmg",
          macArm64Zip: "https://downloads.test/mac-arm64.zip",
          macX64Dmg: "https://downloads.test/mac-x64.dmg",
          macX64Zip: "https://downloads.test/mac-x64.zip",
        }}
      />,
    );

    const intelLabel = screen.getByText("macOS · Intel");
    const intelRow = intelLabel.parentElement?.parentElement;
    expect(intelRow).not.toBeNull();
    expect(within(intelRow!).getByRole("link", { name: ".dmg" })).toHaveAttribute(
      "href",
      "https://downloads.test/mac-x64.dmg",
    );
    expect(within(intelRow!).getByRole("link", { name: ".zip" })).toHaveAttribute(
      "href",
      "https://downloads.test/mac-x64.zip",
    );
  });

  it("labels rows served from an older release with that version", () => {
    render(
      <AllPlatforms
        latestVersion="v0.0.3"
        assets={{
          macArm64Dmg: "https://downloads.test/v0.0.3/mac-arm64.dmg",
          winX64Exe: "https://downloads.test/v0.0.2/win-x64.exe",
          linuxArm64AppImage: "https://downloads.test/v0.0.3/linux-arm64.AppImage",
          linuxArm64Deb: "https://downloads.test/v0.0.2/linux-arm64.deb",
        }}
        assetVersions={{
          macArm64Dmg: "v0.0.3",
          winX64Exe: "v0.0.2",
          linuxArm64AppImage: "v0.0.3",
          linuxArm64Deb: "v0.0.2",
        }}
      />,
    );

    const rowOf = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!;

    expect(
      within(rowOf("macOS · Apple Silicon")).queryByRole("link", {
        name: "v0.0.3",
      }),
    ).toBeNull();
    expect(
      within(rowOf("Windows · x64")).getByRole("link", { name: "v0.0.2" }),
    ).toHaveAttribute("href", "/download/releases/v0.0.2");

    // Mixed sources: only the older format carries the version.
    const linuxArm = rowOf("Linux · ARM64");
    const debLink = within(linuxArm).getByRole("link", { name: ".deb" });
    expect(
      within(debLink.parentElement!).getByRole("link", { name: "v0.0.2" }),
    ).toBeInTheDocument();
    expect(within(linuxArm).getAllByRole("link", { name: "v0.0.2" })).toHaveLength(1);
  });

  it("keeps formats no recent release carries disabled", () => {
    render(
      <AllPlatforms
        latestVersion="v0.0.3"
        assets={{ macArm64Dmg: "https://downloads.test/v0.0.3/mac-arm64.dmg" }}
        assetVersions={{ macArm64Dmg: "v0.0.3" }}
      />,
    );

    const winRow = screen.getByText("Windows · x64").parentElement!.parentElement!;
    expect(within(winRow).queryByRole("link")).toBeNull();
    expect(within(winRow).getByText(".exe")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
