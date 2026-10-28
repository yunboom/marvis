// Path prefix the web app is served under (e.g. `/marvis` behind a shared
// reverse-proxy domain), or "" at the root. Next.js bakes `basePath` into the
// build, so this is a build-time value: NEXT_PUBLIC_ inlines it into both the
// client bundle and the server output, and a prebuilt image cannot change it.
//
// Next.js prefixes `<Link>`, `router.*`, `redirect()` and `_next` assets on its
// own. URLs assembled by hand from `window.location.origin`, bare
// site-relative fetches, and string `src` values on next/image need this
// constant.
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return trimmed ? `/${trimmed}` : "";
}

export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
