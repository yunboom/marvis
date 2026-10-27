// The public docs site (marvis.ai/docs) is not deployed, so every in-app entry
// that opens it stays hidden. Flip to true once the site is live.
export const DOCS_LINKS_ENABLED: boolean = false;

// Docs-site path prefix for a UI language. English docs are prefix-less;
// every other docs locale lives under `/docs/<lang>/`.
export function docsLocalePrefix(language?: string): string {
  if (language?.startsWith("zh")) return "/zh";
  if (language?.startsWith("ja")) return "/ja";
  if (language?.startsWith("ko")) return "/ko";
  if (language?.startsWith("fr")) return "/fr";
  return "";
}
