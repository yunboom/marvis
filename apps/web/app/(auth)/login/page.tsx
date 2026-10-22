"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@marvis/core/auth";
import { useConfigStore } from "@marvis/core/config";
import {
  workspaceKeys,
  workspaceListOptions,
} from "@marvis/core/workspace/queries";
import {
  paths,
  resolvePostAuthDestination,
  useHasOnboarded,
} from "@marvis/core/paths";
import { api } from "@marvis/core/api";
import type { Workspace } from "@marvis/core/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@marvis/ui/components/ui/card";
import { Button } from "@marvis/ui/components/ui/button";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { Loader2 } from "lucide-react";
import { setLoggedInCookie } from "@/features/auth/auth-cookie";
import Link from "next/link";
import {
  LARK_PROVIDER_STATE,
  LoginPage,
  validateCliCallback,
} from "@marvis/views/auth";
import { useT } from "@marvis/views/i18n";

/**
 * Pick where a logged-in user with no explicit `?next=` should land.
 * Un-onboarded users with pending invitations on their email get routed to
 * the batch /invitations page; everyone else falls through to the standard
 * resolver. A network blip on listMyInvitations is non-fatal — we fall
 * through rather than trap the user on an error screen.
 */
async function resolveLoggedInDestination(
  qc: QueryClient,
  hasOnboarded: boolean,
  workspaces: Workspace[],
): Promise<string> {
  if (!hasOnboarded) {
    try {
      const invites = await api.listMyInvitations();
      if (invites.length > 0) {
        qc.setQueryData(workspaceKeys.myInvitations(), invites);
        return paths.invitations();
      }
    } catch {
      // fall through
    }
  }
  return resolvePostAuthDestination(workspaces, hasOnboarded);
}

// 桌面登录跳转卡片：384 宽、24 圆角，和登录卡同一套外壳。
const HANDOFF_SHELL_CLASS =
  "flex min-h-svh items-center justify-center bg-app-shell px-4";
const HANDOFF_CARD_CLASS =
  "w-full max-w-[384px] gap-0 rounded-2xl border-0 px-8 py-9 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border dark:shadow-none";
const HANDOFF_DESCRIPTION_CLASS = "text-body-lg leading-relaxed";

function LoginPageContent() {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useT("auth");
  const googleClientId = useConfigStore((state) => state.googleClientId);
  const larkLoginAppId = useConfigStore((state) => state.larkLoginAppId);
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const searchParams = useSearchParams();

  const cliCallbackRaw = searchParams.get("cli_callback");
  const cliState = searchParams.get("cli_state") || "";
  const platform = searchParams.get("platform");
  const isDesktopHandoff = platform === "desktop" && !cliCallbackRaw;
  // `next` carries a protected URL the user was originally headed to
  // (e.g. /invite/{id}). With URL-driven workspaces there is no legacy
  // "/issues" default — if `next` is absent we decide after login based on
  // the user's workspace list. Sanitize first so a crafted `?next=https://evil`
  // cannot bounce the user off-origin after a successful login.
  const nextUrl = sanitizeNextUrl(searchParams.get("next"));

  const [desktopToken, setDesktopToken] = useState<string | null>(null);
  const [desktopError, setDesktopError] = useState("");
  const hasOnboarded = useHasOnboarded();

  // Latched once auth has been observed settled as logged-out on this page.
  // Any `user` that appears afterwards came from the login form in this
  // session — not from an existing session found on arrival.
  const settledLoggedOutRef = useRef(false);

  // Already authenticated ON ARRIVAL — honor ?next= or fall back to first
  // workspace (or /onboarding if the user has none). Skip this entire path
  // when the user arrived to authorize the CLI.
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      settledLoggedOutRef.current = true;
      return;
    }
    if (cliCallbackRaw) return;
    if (isDesktopHandoff) {
      // Desktop opened the browser for login but the web session is already
      // authenticated — mint a bearer token from the cookie session and hand
      // it off via deep link instead of silently redirecting to the workspace.
      api
        .issueCliToken()
        .then(({ token }) => {
          setDesktopToken(token);
          window.location.href = `marvis://auth/callback?token=${encodeURIComponent(token)}`;
        })
        .catch((err) => {
          setDesktopError(
            err instanceof Error
              ? err.message
              : t(($) => $.web.desktop_handoff.prepare_failed),
          );
        });
      return;
    }
    // Fresh form login (issue #5009): `user` was written by verifyCode while
    // handleVerify was still fetching the workspace list, so this effect used
    // to read the not-yet-seeded list cache and race handleSuccess with a
    // replace to /workspaces/new. handleSuccess owns post-login navigation;
    // this effect only serves visitors who arrived already authenticated.
    if (settledLoggedOutRef.current) return;
    if (nextUrl) {
      router.replace(nextUrl);
      return;
    }
    // Fetch instead of reading the cache: on a fresh page load the cache is
    // cold, and `getQueryData() ?? []` would misroute a user who does have
    // workspaces to /workspaces/new. On fetch failure fall back to [] —
    // same destination the cold-cache read produced, rather than trapping
    // the user on the login page.
    void qc
      .ensureQueryData(workspaceListOptions())
      .catch(() => [] as Workspace[])
      .then((list) => resolveLoggedInDestination(qc, hasOnboarded, list))
      .then((dest) => router.replace(dest));
  }, [isLoading, user, router, nextUrl, cliCallbackRaw, isDesktopHandoff, hasOnboarded, qc]);

  const handleSuccess = async () => {
    // Read the latest user snapshot directly — the closure's `hasOnboarded`
    // was captured before login completed and would be stale here.
    const currentUser = useAuthStore.getState().user;
    const onboarded = currentUser?.onboarded_at != null;
    if (nextUrl) {
      router.push(nextUrl);
      return;
    }
    const list = qc.getQueryData<Workspace[]>(workspaceKeys.list()) ?? [];
    router.push(await resolveLoggedInDestination(qc, onboarded, list));
  };

  // Build Google OAuth state: encode platform, next URL, and CLI callback
  // params so the callback can redirect to the right place after login.
  // CLI callback/state must survive the Google OAuth round-trip so the
  // post-login callback page can redirect the JWT back to the CLI's local
  // HTTP listener (critical for headless / WSL2 environments).
  const googleState = [
    platform === "desktop" ? "platform:desktop" : "",
    nextUrl ? `next:${nextUrl}` : "",
    cliCallbackRaw && validateCliCallback(cliCallbackRaw)
      ? `cli_callback:${encodeURIComponent(cliCallbackRaw)}`
      : "",
    cliState ? `cli_state:${encodeURIComponent(cliState)}` : "",
  ]
    .filter(Boolean)
    .join(",") || undefined;
  // 飞书授权沿用同一份 state，多带 provider:lark 让回调页区分登录方式。
  const larkState = [LARK_PROVIDER_STATE, googleState].filter(Boolean).join(",");

  // While the desktop handoff is in progress (or has produced a token/error),
  // render a dedicated screen instead of flashing the login form or redirecting
  // away to a workspace page.
  if (isDesktopHandoff && user) {
    if (desktopError) {
      return (
        <div className={HANDOFF_SHELL_CLASS}>
          <Card className={HANDOFF_CARD_CLASS}>
            <CardHeader className="gap-2 px-0 text-center">
              <CardTitle className="text-display-sm font-bold">
                {t(($) => $.web.desktop_handoff.failed_title)}
              </CardTitle>
              <CardDescription className={HANDOFF_DESCRIPTION_CLASS}>
                {desktopError}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      );
    }
    return (
      <div className={HANDOFF_SHELL_CLASS}>
        <Card className={HANDOFF_CARD_CLASS}>
          <CardHeader className="gap-2 px-0 text-center">
            <CardTitle className="text-display-sm font-bold">
              {t(($) => $.web.desktop_handoff.opening_title)}
            </CardTitle>
            <CardDescription className={HANDOFF_DESCRIPTION_CLASS}>
              {desktopToken
                ? t(($) => $.web.desktop_handoff.opening_description)
                : t(($) => $.web.desktop_handoff.preparing)}
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-6 flex justify-center px-0">
            {desktopToken ? (
              <Button
                variant="outline"
                className="h-11 px-5.5 text-body-lg"
                onClick={() => {
                  window.location.href = `marvis://auth/callback?token=${encodeURIComponent(desktopToken)}`;
                }}
              >
                {t(($) => $.web.desktop_handoff.open_button)}
              </Button>
            ) : (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <LoginPage
      logo={<MarvisIcon className="size-12 text-foreground" />}
      onSuccess={handleSuccess}
      google={
        googleClientId
          ? {
              clientId: googleClientId,
              redirectUri: `${window.location.origin}/auth/callback`,
              state: googleState,
            }
          : undefined
      }
      lark={
        larkLoginAppId
          ? {
              appId: larkLoginAppId,
              redirectUri: `${window.location.origin}/auth/callback`,
              state: larkState,
            }
          : undefined
      }
      cliCallback={
        cliCallbackRaw && validateCliCallback(cliCallbackRaw)
          ? { url: cliCallbackRaw, state: cliState }
          : undefined
      }
      onTokenObtained={setLoggedInCookie}
      extra={
        <span className="text-label text-muted-foreground">
          {t(($) => $.web.prefer_desktop)}{" "}
          <Link
            href="/download"
            className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground/70"
          >
            {t(($) => $.web.download)}
          </Link>
        </span>
      }
    />
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
