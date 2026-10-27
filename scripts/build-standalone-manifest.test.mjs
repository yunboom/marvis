import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PLATFORMS, buildManifest, readAssetsDir } from "./build-standalone-manifest.mjs";

const BASE = "https://github.com/yunboom/marvis/releases/download";

function assetsFor(prefix, version, platforms) {
  return Object.fromEntries(
    platforms.map((p, i) => [p, { name: `${prefix}-${version}-${p}.tar.xz`, size: 100 + i, sha256: `${i}`.repeat(64) }]),
  );
}

const PG_PLATFORMS = PLATFORMS.filter((p) => p !== "windows-arm64");

function sample(overrides = {}) {
  return {
    version: "0.6.6",
    tag: "v0.6.6",
    serverAssets: assetsFor("marvis-server", "0.6.6", PLATFORMS),
    postgres: { version: "17.11.0", tag: "pg-17.11.0", assets: assetsFor("marvis-postgres", "17.11.0", PG_PLATFORMS) },
    baseUrl: BASE,
    ...overrides,
  };
}

test("builds the manifest with release URLs for every platform", () => {
  const m = buildManifest(sample());

  assert.equal(m.schemaVersion, 1);
  assert.equal(m.version, "0.6.6");
  assert.equal(m.minAppVersion, "0.0.0");
  assert.deepEqual(Object.keys(m.server).sort(), [...PLATFORMS].sort());
  assert.deepEqual(m.server["darwin-arm64"].urls, [`${BASE}/v0.6.6/marvis-server-0.6.6-darwin-arm64.tar.xz`]);
  assert.equal(m.postgres.version, "17.11.0");
  assert.deepEqual(m.postgres.assets["linux-amd64"].urls, [`${BASE}/pg-17.11.0/marvis-postgres-17.11.0-linux-amd64.tar.xz`]);
});

test("windows-arm64 reuses the windows-amd64 PostgreSQL bundle", () => {
  const m = buildManifest(sample());

  assert.deepEqual(m.postgres.assets["windows-arm64"], m.postgres.assets["windows-amd64"]);
});

test("adds the mirror URL after the release URL", () => {
  const m = buildManifest(sample({ mirrorBaseUrl: "https://mirror.example.com/marvis/", minAppVersion: "0.6.0" }));

  assert.equal(m.minAppVersion, "0.6.0");
  assert.deepEqual(m.server["linux-arm64"].urls, [
    `${BASE}/v0.6.6/marvis-server-0.6.6-linux-arm64.tar.xz`,
    "https://mirror.example.com/marvis/v0.6.6/marvis-server-0.6.6-linux-arm64.tar.xz",
  ]);
});

test("refuses a manifest with a missing platform", () => {
  const serverAssets = assetsFor("marvis-server", "0.6.6", PLATFORMS.filter((p) => p !== "linux-arm64"));

  assert.throws(() => buildManifest(sample({ serverAssets })), /server.*linux-arm64/);
});

test("reads names, sizes and checksums from an assets directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-manifest-"));
  const name = "marvis-server-0.6.6-darwin-arm64.tar.xz";
  writeFileSync(join(dir, name), "12345");
  writeFileSync(join(dir, `${name}.sha256`), `${"a".repeat(64)}  ${name}\n`);
  writeFileSync(join(dir, "unrelated.txt"), "x");

  assert.deepEqual(readAssetsDir(dir, "marvis-server", "0.6.6"), {
    "darwin-arm64": { name, size: 5, sha256: "a".repeat(64) },
  });
});
