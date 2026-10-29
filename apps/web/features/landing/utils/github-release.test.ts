// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestRelease, fetchRecentReleases } from "./github-release";

/** The twelve desktop artifacts a finished release carries. */
function completeAssets(version: string) {
  return [
    `marvis-desktop-${version}-mac-arm64.dmg`,
    `marvis-desktop-${version}-mac-arm64.zip`,
    `marvis-desktop-${version}-mac-x64.dmg`,
    `marvis-desktop-${version}-mac-x64.zip`,
    `marvis-desktop-${version}-windows-x64.exe`,
    `marvis-desktop-${version}-windows-arm64.exe`,
    `marvis-desktop-${version}-linux-x86_64.AppImage`,
    `marvis-desktop-${version}-linux-amd64.deb`,
    `marvis-desktop-${version}-linux-x86_64.rpm`,
    `marvis-desktop-${version}-linux-arm64.AppImage`,
    `marvis-desktop-${version}-linux-arm64.deb`,
    `marvis-desktop-${version}-linux-aarch64.rpm`,
  ].map((name) => ({
    name,
    browser_download_url: `https://github.test/download/v${version}/${name}`,
  }));
}

/** A release built with the default desktop platforms (macOS only). */
function macOnlyAssets(version: string) {
  return completeAssets(version).filter((a) => a.name.includes("-mac-"));
}

function releasePayload(overrides: {
  tag: string;
  assets?: { name: string; browser_download_url: string }[];
  prerelease?: boolean;
  draft?: boolean;
}) {
  return {
    tag_name: overrides.tag,
    published_at: "2026-08-17T10:00:00Z",
    html_url: `https://github.com/yunboom/marvis/releases/tag/${overrides.tag}`,
    prerelease: overrides.prerelease ?? false,
    draft: overrides.draft ?? false,
    assets: overrides.assets ?? [],
  };
}

function mockFetchWithReleases(releases: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(releases), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchLatestRelease", () => {
  it("offers every download from the latest release when it is complete", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.2.14", assets: completeAssets("0.2.14") }),
      releasePayload({ tag: "v0.2.13", assets: completeAssets("0.2.13") }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.version).toBe("v0.2.14");
    expect(result.assets.winX64Exe).toContain("0.2.14");
    expect(new Set(Object.values(result.assetVersions))).toEqual(
      new Set(["v0.2.14"]),
    );
  });

  // Releases build only the macOS installers unless Windows/Linux are
  // enabled for that tag, so those buttons must keep pointing at the newest
  // release that has them instead of going disabled.
  it("takes macOS from a macOS-only latest release and Windows/Linux from an older full one", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.0.3", assets: macOnlyAssets("0.0.3") }),
      releasePayload({ tag: "v0.0.2", assets: completeAssets("0.0.2") }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.version).toBe("v0.0.3");
    expect(result.assets.macArm64Dmg).toContain("0.0.3");
    expect(result.assets.macX64Zip).toContain("0.0.3");
    expect(result.assets.winX64Exe).toContain("0.0.2");
    expect(result.assets.linuxArm64Rpm).toContain("0.0.2");
    expect(result.assetVersions).toMatchObject({
      macArm64Dmg: "v0.0.3",
      macX64Zip: "v0.0.3",
      winX64Exe: "v0.0.2",
      winArm64Exe: "v0.0.2",
      linuxAmd64Deb: "v0.0.2",
      linuxArm64Rpm: "v0.0.2",
    });
  });

  it("picks each format from the newest release that has it", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.5.2", assets: macOnlyAssets("0.5.2") }),
      releasePayload({
        tag: "v0.5.1",
        assets: completeAssets("0.5.1").filter((a) => a.name.endsWith(".deb")),
      }),
      releasePayload({ tag: "v0.5.0", assets: [] }),
      releasePayload({ tag: "v0.4.9", assets: completeAssets("0.4.9") }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.assetVersions.linuxAmd64Deb).toBe("v0.5.1");
    expect(result.assetVersions.linuxAmd64AppImage).toBe("v0.4.9");
    expect(result.assetVersions.winArm64Exe).toBe("v0.4.9");
    expect(result.assetVersions.macArm64Dmg).toBe("v0.5.2");
  });

  it("leaves a platform out when no recent release has it", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.4.28", assets: macOnlyAssets("0.4.28") }),
      releasePayload({ tag: "v0.4.27", assets: macOnlyAssets("0.4.27") }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.version).toBe("v0.4.28");
    expect(result.assets.macArm64Dmg).toContain("0.4.28");
    expect(result.assets.winX64Exe).toBeUndefined();
    expect(result.assets.linuxAmd64AppImage).toBeUndefined();
    expect(result.assetVersions.winX64Exe).toBeUndefined();
  });

  it("skips prereleases and drafts", async () => {
    mockFetchWithReleases([
      releasePayload({
        tag: "v0.2.15-rc.1",
        prerelease: true,
        assets: completeAssets("0.2.15-rc.1"),
      }),
      releasePayload({
        tag: "v0.2.15",
        draft: true,
        assets: completeAssets("0.2.15"),
      }),
      releasePayload({ tag: "v0.2.14", assets: completeAssets("0.2.14") }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.version).toBe("v0.2.14");
    expect(result.assets.winX64Exe).toContain("0.2.14");
  });

  it("shares the release list request with the release pages", async () => {
    const fetchMock = mockFetchWithReleases([]);

    await fetchLatestRelease();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/yunboom/marvis/releases?per_page=20",
    );
  });

  it("returns an empty release shape when the API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchLatestRelease();
    expect(result).toEqual({
      version: null,
      publishedAt: null,
      assets: {},
      assetVersions: {},
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns an empty release shape when all releases are filtered out", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.2.15-rc.1", prerelease: true }),
      releasePayload({ tag: "v0.2.14-draft", draft: true }),
    ]);

    const result = await fetchLatestRelease();
    expect(result.version).toBeNull();
    expect(result.assets).toEqual({});
  });
});

describe("fetchRecentReleases", () => {
  it("lists stable releases newest first with their parsed assets", async () => {
    mockFetchWithReleases([
      releasePayload({ tag: "v0.0.2-rc.1", prerelease: true }),
      releasePayload({ tag: "v0.0.2", assets: macOnlyAssets("0.0.2") }),
      releasePayload({ tag: "v0.0.1", assets: completeAssets("0.0.1") }),
    ]);

    const result = await fetchRecentReleases();
    expect(result.map((r) => r.version)).toEqual(["v0.0.2", "v0.0.1"]);
    expect(result[0]!.publishedAt).toBe("2026-08-17T10:00:00Z");
    expect(result[0]!.assets.macArm64Dmg).toContain("mac-arm64.dmg");
    expect(result[0]!.assets.winX64Exe).toBeUndefined();
  });

  it("returns an empty list when the API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 403 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await fetchRecentReleases()).toEqual([]);
  });
});
