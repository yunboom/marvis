// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseReleaseAssets } from "./parse-release-assets";

function asset(name: string) {
  return {
    name,
    browser_download_url: `https://github.test/releases/${name}`,
  };
}

describe("parseReleaseAssets", () => {
  it("keeps both Apple Silicon and Intel macOS installers", () => {
    const assets = parseReleaseAssets([
      asset("marvis-desktop-0.4.2-mac-arm64.dmg"),
      asset("marvis-desktop-0.4.2-mac-arm64.zip"),
      asset("marvis-desktop-0.4.2-mac-x64.dmg"),
      asset("marvis-desktop-0.4.2-mac-x64.zip"),
      asset("marvis-desktop-0.4.2-mac-x64.dmg.blockmap"),
      asset("latest-x64-mac.yml"),
    ]);

    expect(assets).toEqual({
      macArm64Dmg:
        "https://github.test/releases/marvis-desktop-0.4.2-mac-arm64.dmg",
      macArm64Zip:
        "https://github.test/releases/marvis-desktop-0.4.2-mac-arm64.zip",
      macX64Dmg:
        "https://github.test/releases/marvis-desktop-0.4.2-mac-x64.dmg",
      macX64Zip:
        "https://github.test/releases/marvis-desktop-0.4.2-mac-x64.zip",
    });
  });
});

/** Every artifact name a finished release publishes, in real-world form —
 *  note Linux arch varies by format (x86_64 for AppImage/rpm, amd64 for
 *  deb; aarch64 for rpm, arm64 for the rest). */
const ALL_ARTIFACT_NAMES = [
  "marvis-desktop-0.4.27-mac-arm64.dmg",
  "marvis-desktop-0.4.27-mac-arm64.zip",
  "marvis-desktop-0.4.27-mac-x64.dmg",
  "marvis-desktop-0.4.27-mac-x64.zip",
  "marvis-desktop-0.4.27-windows-x64.exe",
  "marvis-desktop-0.4.27-windows-arm64.exe",
  "marvis-desktop-0.4.27-linux-x86_64.AppImage",
  "marvis-desktop-0.4.27-linux-amd64.deb",
  "marvis-desktop-0.4.27-linux-x86_64.rpm",
  "marvis-desktop-0.4.27-linux-arm64.AppImage",
  "marvis-desktop-0.4.27-linux-arm64.deb",
  "marvis-desktop-0.4.27-linux-aarch64.rpm",
];

describe("parseReleaseAssets on a full release", () => {
  it("maps each of the twelve desktop artifacts to its own key", () => {
    const assets = parseReleaseAssets(ALL_ARTIFACT_NAMES.map(asset));

    expect(Object.keys(assets)).toHaveLength(ALL_ARTIFACT_NAMES.length);
    expect(new Set(Object.values(assets))).toEqual(
      new Set(ALL_ARTIFACT_NAMES.map((n) => asset(n).browser_download_url)),
    );
  });
});
