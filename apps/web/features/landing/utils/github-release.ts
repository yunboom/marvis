import {
  parseReleaseAssets,
  type DownloadAssets,
} from "./parse-release-assets";

/**
 * Server-side fetchers for the /download pages, designed to run inside
 * Next.js server components. Responses are cached by the Next.js fetch cache
 * for 5 minutes (Vercel ISR), and every page reads the same release list, so
 * /download and the release pages together cost at most one GitHub API call
 * per region per 5 minutes.
 *
 * A release does not always carry every desktop installer: releases build the
 * macOS installers by default and Windows/Linux only when enabled (see
 * RELEASE_DESKTOP_PLATFORMS in .github/RELEASING.md), and a packaging job can
 * also fail. /download therefore offers each format from the newest release
 * that has it, so a macOS-only release does not disable the Windows and Linux
 * buttons.
 *
 * On any failure (network, rate limit, malformed payload) the fetchers return
 * an empty result and log — the page degrades to a "version unavailable" view
 * rather than 500ing.
 */

/** The release a desktop download comes from, keyed by asset. */
export type AssetVersions = Partial<Record<keyof DownloadAssets, string>>;

export interface LatestRelease {
  /** Newest stable release; null when GitHub cannot be reached. */
  version: string | null;
  publishedAt: string | null;
  /** Each format's download from the newest release that carries it. */
  assets: DownloadAssets;
  /** Which release each entry of `assets` comes from. */
  assetVersions: AssetVersions;
}

// The all-releases page lists this many recent versions; older ones stay on
// the server-side API but are not linked from the site. /download looks for
// each platform's installers within the same window.
const RELEASE_LIST_SIZE = 20;

const GITHUB_RELEASES_URL = "https://api.github.com/repos/yunboom/marvis/releases";

const REVALIDATE_SECONDS = 300;

interface GitHubReleasePayload {
  tag_name?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/** One published version as the in-site release pages show it. */
export interface ReleaseSummary {
  version: string;
  publishedAt: string | null;
  assets: DownloadAssets;
}

/**
 * Newest stable releases, newest first. Throws on network / API errors so
 * each caller picks its own degradation.
 */
async function fetchStableReleases(): Promise<GitHubReleasePayload[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Optional PAT for local development and self-hosted deploys where
  // the shared outbound IP keeps hitting the 60-requests/hour
  // unauthenticated limit. Vercel's fetch cache is shared across all
  // regions so production rarely needs this — but the env var lets
  // anyone running the site locally avoid the rate-limit dance. Never
  // prefix this with `NEXT_PUBLIC_`; the token must stay server-side.
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${GITHUB_RELEASES_URL}?per_page=${RELEASE_LIST_SIZE}`, {
    next: { revalidate: REVALIDATE_SECONDS },
    headers,
  });
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status}`);
  }
  const data = (await res.json()) as GitHubReleasePayload[];

  // Defensive filter — Marvis doesn't publish prereleases or drafts
  // today, but the endpoint returns them if that ever changes. A
  // prerelease shadowing a stable version on /download would be a
  // regression.
  return data.filter((r) => !r.prerelease && !r.draft);
}

/** Recent stable releases, newest first, for every /download page; an empty
 *  list when GitHub cannot be reached. */
export async function fetchRecentReleases(): Promise<ReleaseSummary[]> {
  try {
    const stable = await fetchStableReleases();
    return stable
      .filter((r) => r.tag_name)
      .map((r) => ({
        version: r.tag_name!,
        publishedAt: r.published_at ?? null,
        assets: parseReleaseAssets(r.assets ?? []),
      }));
  } catch (err) {
    console.warn("[download] fetchRecentReleases failed:", err);
    return [];
  }
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const releases = await fetchRecentReleases();
  const latest = releases[0];
  if (!latest) {
    return emptyRelease();
  }

  return {
    version: latest.version,
    publishedAt: latest.publishedAt,
    ...newestAssets(releases),
  };
}

/** For each asset, the newest release (list is newest first) that has it. */
function newestAssets(
  releases: ReleaseSummary[],
): Pick<LatestRelease, "assets" | "assetVersions"> {
  const assets: DownloadAssets = {};
  const assetVersions: AssetVersions = {};
  for (const release of releases) {
    for (const [key, url] of Object.entries(release.assets) as [
      keyof DownloadAssets,
      string | undefined,
    ][]) {
      if (!url || assets[key]) continue;
      assets[key] = url;
      assetVersions[key] = release.version;
    }
  }

  return { assets, assetVersions };
}

function emptyRelease(): LatestRelease {
  return {
    version: null,
    publishedAt: null,
    assets: {},
    assetVersions: {},
  };
}
