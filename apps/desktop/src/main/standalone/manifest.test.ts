// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { compareVersions, fetchManifest, parseManifest, ManifestError } from "./manifest";

const asset = (name: string) => ({
  name,
  size: 10,
  sha256: "a".repeat(64),
  urls: [`https://github.com/yunboom/marvis/releases/download/v0.6.6/${name}`],
});

function sample(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: "0.6.6",
    minAppVersion: "0.0.0",
    server: { "darwin-arm64": asset("marvis-server-0.6.6-darwin-arm64.tar.xz") },
    postgres: { version: "17.11.0", assets: { "darwin-arm64": asset("marvis-postgres-17.11.0-darwin-arm64.tar.xz") } },
  };
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = parseManifest(sample());
    expect(m?.version).toBe("0.6.6");
    expect(m?.server["darwin-arm64"]?.name).toBe("marvis-server-0.6.6-darwin-arm64.tar.xz");
    expect(m?.postgres.assets["darwin-arm64"]?.urls).toHaveLength(1);
  });

  it("drops unknown platforms and ignores extra keys", () => {
    const raw = sample();
    (raw.server as Record<string, unknown>)["plan9-mips"] = asset("x.tar.xz");
    raw.extra = true;
    const m = parseManifest(raw);
    expect(Object.keys(m?.server ?? {})).toEqual(["darwin-arm64"]);
  });

  it.each([
    ["wrong schema version", (r: Record<string, unknown>) => (r.schemaVersion = 2)],
    ["missing version", (r: Record<string, unknown>) => delete r.version],
    ["asset without urls", (r: Record<string, unknown>) => ((r.server as Record<string, Record<string, unknown>>)["darwin-arm64"].urls = [])],
    ["non-https url", (r: Record<string, unknown>) => ((r.server as Record<string, Record<string, unknown>>)["darwin-arm64"].urls = ["ftp://x"])],
    ["bad sha256", (r: Record<string, unknown>) => ((r.server as Record<string, Record<string, unknown>>)["darwin-arm64"].sha256 = "xyz")],
    ["path in asset name", (r: Record<string, unknown>) => ((r.server as Record<string, Record<string, unknown>>)["darwin-arm64"].name = "../evil.tar.xz")],
  ])("rejects %s", (_label, mutate) => {
    const raw = sample();
    mutate(raw);
    expect(parseManifest(raw)).toBeNull();
  });
});

describe("fetchManifest", () => {
  it("fetches and parses", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample()), { status: 200 }));
    const m = await fetchManifest("https://example.com/server-manifest.json", fetchImpl as unknown as typeof fetch);
    expect(m.version).toBe("0.6.6");
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/server-manifest.json", expect.objectContaining({ redirect: "follow" }));
  });

  it("throws ManifestError on HTTP errors and malformed bodies", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchManifest("https://x", notFound as unknown as typeof fetch)).rejects.toBeInstanceOf(ManifestError);
    const garbage = vi.fn(async () => new Response("{", { status: 200 }));
    await expect(fetchManifest("https://x", garbage as unknown as typeof fetch)).rejects.toBeInstanceOf(ManifestError);
  });
});

describe("compareVersions", () => {
  it.each([
    ["0.6.6", "0.6.6", 0],
    ["0.6.10", "0.6.9", 1],
    ["0.6.6", "0.7.0", -1],
    ["v1.2.3", "1.2.3", 0],
    ["1.2.3-rc.1", "1.2.3", -1],
    ["1.2.3", "1.2.3-rc.1", 1],
    ["1.2", "1.2.0", 0],
  ])("compareVersions(%s, %s) = %i", (a, b, want) => {
    expect(Math.sign(compareVersions(a, b))).toBe(want);
  });
});
