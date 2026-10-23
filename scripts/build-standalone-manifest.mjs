#!/usr/bin/env node
// Builds the JSON manifests the desktop app reads to download standalone-mode
// resources (see docs/superpowers/plans/2026-10-23-standalone-mode.md).
//
//   node scripts/build-standalone-manifest.mjs postgres --dir <dir> --version <pg> --tag <tag>
//     -> postgres-manifest.json describing the repacked PostgreSQL bundles
//   node scripts/build-standalone-manifest.mjs server --dir <dir> --version <v> --tag <tag>
//        --postgres-manifest <file> --base-url <url> [--mirror-base-url <url>] [--min-app-version <v>]
//     -> server-manifest.json, the file the desktop app fetches
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Platform keys the desktop app looks up: `<os>-<arch>`. */
export const PLATFORMS = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"];

/** zonky publishes no Windows arm64 build; Windows on ARM runs the x64 one. */
const POSTGRES_ALIASES = { "windows-arm64": "windows-amd64" };

/**
 * Reads `<prefix>-<version>-<os>-<arch>.tar.xz` files and their `.sha256`
 * siblings from dir, keyed by platform.
 */
export function readAssetsDir(dir, prefix, version) {
  const head = `${prefix}-${version}-`;
  const assets = {};
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(head) || !name.endsWith(".tar.xz")) continue;
    const platform = name.slice(head.length, -".tar.xz".length);
    const sha256 = readFileSync(join(dir, `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
    assets[platform] = { name, size: statSync(join(dir, name)).size, sha256 };
  }
  return assets;
}

function withUrls(assets, tag, baseUrl, mirrorBaseUrl) {
  const trim = (url) => url.replace(/\/+$/, "");
  const out = {};
  for (const [platform, asset] of Object.entries(assets)) {
    const urls = [`${trim(baseUrl)}/${tag}/${asset.name}`];
    if (mirrorBaseUrl) urls.push(`${trim(mirrorBaseUrl)}/${tag}/${asset.name}`);
    out[platform] = { ...asset, urls };
  }
  return out;
}

function requireAll(kind, assets) {
  const missing = PLATFORMS.filter((p) => !assets[p]);
  if (missing.length > 0) {
    throw new Error(`${kind} assets missing for: ${missing.join(", ")}`);
  }
}

/** Builds server-manifest.json; throws when any platform lacks a bundle. */
export function buildManifest({ version, tag, serverAssets, postgres, baseUrl, mirrorBaseUrl, minAppVersion }) {
  const pgAssets = { ...postgres.assets };
  for (const [alias, source] of Object.entries(POSTGRES_ALIASES)) {
    if (!pgAssets[alias] && pgAssets[source]) pgAssets[alias] = pgAssets[source];
  }
  requireAll("server", serverAssets);
  requireAll("postgres", pgAssets);

  return {
    schemaVersion: 1,
    version,
    minAppVersion: minAppVersion || "0.0.0",
    server: withUrls(serverAssets, tag, baseUrl, mirrorBaseUrl),
    postgres: { version: postgres.version, assets: withUrls(pgAssets, postgres.tag, baseUrl, mirrorBaseUrl) },
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined) {
      throw new Error(`bad argument: ${rest[i]}`);
    }
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

function main(argv) {
  const { command, opts } = parseArgs(argv);
  const need = (key) => {
    if (!opts[key]) throw new Error(`--${key} is required`);
    return opts[key];
  };

  if (command === "postgres") {
    const version = need("version");
    return { version, tag: need("tag"), assets: readAssetsDir(need("dir"), "marvis-postgres", version) };
  }
  if (command === "server") {
    const version = need("version");
    return buildManifest({
      version,
      tag: need("tag"),
      serverAssets: readAssetsDir(need("dir"), "marvis-server", version),
      postgres: JSON.parse(readFileSync(need("postgres-manifest"), "utf8")),
      baseUrl: need("base-url"),
      mirrorBaseUrl: opts["mirror-base-url"],
      minAppVersion: opts["min-app-version"],
    });
  }
  throw new Error("usage: build-standalone-manifest.mjs <postgres|server> --dir <dir> --version <v> --tag <tag> ...");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
