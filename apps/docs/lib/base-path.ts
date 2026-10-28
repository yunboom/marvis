// basePath the docs app is built under: `/docs`, behind an optional deployment
// prefix shared with the web app (`NEXT_PUBLIC_BASE_PATH=/marvis` serves docs
// at `/marvis/docs`). Build-time only — keep in sync with next.config.mjs,
// which cannot import TypeScript.
function normalizePrefix(raw: string | undefined): string {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return trimmed ? `/${trimmed}` : "";
}

export const BASE_PATH = `${normalizePrefix(process.env.NEXT_PUBLIC_BASE_PATH)}/docs`;
