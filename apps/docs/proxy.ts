import { NextResponse, type NextRequest } from "next/server";
import { i18n } from "@/lib/i18n";

// Self-contained i18n proxy. We don't use fumadocs-core's built-in
// middleware because it isn't basePath-aware — both its rewrite targets
// and redirect Location headers are built from the basePath-stripped path,
// leaving URLs like `/en/agents` or `/` that Next then fails to resolve
// inside a basePath-mounted app. Logic mirrors fumadocs's default-locale
// flavor: hide `/en` prefix for the default language, keep `/zh` prefix
// for other languages.

// Marks a request this proxy already rewrote to the default-language route.
// Next runs the proxy again on the rewritten `/en/...` path, where the strip
// branch would redirect it straight back to the prefix-less URL — a loop.
// A client sending the header itself only gets the non-canonical `/en/...`
// page rendered in place.
const LOCALE_REWRITE_HEADER = "x-docs-locale-rewrite";

export function proxy(request: NextRequest) {
  if (request.headers.has(LOCALE_REWRITE_HEADER)) return NextResponse.next();

  const pathname = request.nextUrl.pathname;
  const pathLocale = i18n.languages.find(
    (loc) => pathname === `/${loc}` || pathname.startsWith(`/${loc}/`),
  );

  if (!pathLocale) {
    // No locale in URL → rewrite to the default-language route. `nextUrl`'s
    // pathname is basePath-stripped and it re-adds the basePath itself.
    const url = request.nextUrl.clone();
    url.pathname = `/${i18n.defaultLanguage}${pathname === "/" ? "" : pathname}`;
    const headers = new Headers(request.headers);
    headers.set(LOCALE_REWRITE_HEADER, "1");
    return NextResponse.rewrite(url, { request: { headers } });
  }

  if (pathLocale === i18n.defaultLanguage) {
    // Explicit default-language prefix → strip it so the canonical URL
    // is prefix-less. The clone keeps the search string, so marketing UTMs /
    // referral params survive the locale strip.
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(`/${pathLocale}`.length) || "/";
    return NextResponse.redirect(url);
  }

  // Non-default locale in URL → let it through; Next matches on the
  // `[lang]` segment directly.
  return NextResponse.next();
}

export const config = {
  // Run on every path except static/api and root metadata routes. Includes
  // the bare `/` root so `/docs/` lands on the English home. `sitemap.xml`
  // and `robots.txt` MUST be excluded — they're not under `[lang]/`, so
  // routing them through the locale rewrite would 404 the sitemap that
  // robots.txt advertises to crawlers.
  matcher: [
    "/((?!api|_next/static|_next/image|images|favicon.ico|sitemap.xml|robots.txt).*)",
    "/",
  ],
};
