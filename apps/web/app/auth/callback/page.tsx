"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@marvis/core/auth";
import { workspaceKeys } from "@marvis/core/workspace/queries";
import { paths, resolvePostAuthDestination } from "@marvis/core/paths";
import { api } from "@marvis/core/api";
import { createLogger } from "@marvis/core/logger";
import {
  LARK_PROVIDER_STATE,
  validateCliCallback,
  redirectToCliCallback,
} from "@marvis/views/auth";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@marvis/ui/components/ui/card";
import { Button } from "@marvis/ui/components/ui/button";
import { useT } from "@marvis/views/i18n";
import { Loader2 } from "lucide-react";
import { BASE_PATH } from "@/config/base-path";
import { callbackErrorFrom, type CallbackError } from "./callback-error";

const authLogger = createLogger("auth.callback");

function CallbackContent() {
  const { t } = useT("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const loginWithLark = useAuthStore((s) => s.loginWithLark);
  const [error, setError] = useState<CallbackError | null>(null);
  // state 带 provider:lark 时本次回调来自飞书授权，错误文案按飞书展示。
  const isLark = (searchParams.get("state") || "").split(",").includes(LARK_PROVIDER_STATE);
  const [desktopToken, setDesktopToken] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const errorParam = searchParams.get("error");
    const providerLabel = isLark ? "Feishu" : "Google";
    if (errorParam) {
      authLogger.warn(`${providerLabel} OAuth returned an error parameter`, errorParam);
      setError(
        errorParam === "access_denied"
          ? { kind: "access_denied" }
          : { kind: "login_failed" },
      );
      return;
    }

    if (!code) {
      setError({ kind: "missing_code" });
      return;
    }

    const state = searchParams.get("state") || "";
    const stateParts = state.split(",");
    const isDesktop = stateParts.includes("platform:desktop");
    const nextPart = stateParts.find((p) => p.startsWith("next:"));
    // Strip "next:" prefix, then drop anything that isn't a safe relative path
    // so an attacker-controlled `state=next:https://evil` cannot redirect here.
    const nextUrl = sanitizeNextUrl(nextPart ? nextPart.slice(5) : null);

    // CLI callback params — carried across the Google OAuth round-trip so
    // headless/WSL2 `marvis login` can receive the JWT after browser-based
    // Google auth completes.
    const cliCallbackPart = stateParts.find((p) => p.startsWith("cli_callback:"));
    const cliStatePart = stateParts.find((p) => p.startsWith("cli_state:"));
    const cliCallbackRaw = cliCallbackPart
      ? decodeURIComponent(cliCallbackPart.slice("cli_callback:".length))
      : null;
    const cliState = cliStatePart
      ? decodeURIComponent(cliStatePart.slice("cli_state:".length))
      : "";

    const redirectUri = `${window.location.origin}${BASE_PATH}/auth/callback`;
    // 按授权来源选择换取 token 的接口，其余流程 Google 与飞书一致。
    const exchangeCode = isLark
      ? () => api.larkLogin(code, redirectUri, "oauth")
      : () => api.googleLogin(code, redirectUri);
    const webLogin = isLark
      ? () => loginWithLark(code, redirectUri, "oauth")
      : () => loginWithGoogle(code, redirectUri);

    // Validate the CLI callback URL before redirecting — the state parameter
    // passes through Google OAuth and must be treated as attacker-controlled.
    const cliCallback =
      cliCallbackRaw && validateCliCallback(cliCallbackRaw)
        ? cliCallbackRaw
        : null;

    if (cliCallback) {
      // CLI login flow: exchange the Google code for a JWT, then redirect the
      // token back to the CLI's local HTTP listener (e.g. WSL2 host).
      exchangeCode()
        .then(({ token }) => {
          redirectToCliCallback(cliCallback, token, cliState);
        })
        .catch((err) => {
          authLogger.error(`CLI ${providerLabel} OAuth callback failed`, err);
          setError(callbackErrorFrom(err));
        });
    } else if (isDesktop) {
      // Desktop flow: exchange code for token, then redirect via deep link
      exchangeCode()
        .then(({ token }) => {
          setDesktopToken(token);
          window.location.href = `marvis://auth/callback?token=${encodeURIComponent(token)}`;
        })
        .catch((err) => {
          authLogger.error(`Desktop ${providerLabel} OAuth callback failed`, err);
          setError(callbackErrorFrom(err));
        });
    } else {
      // Normal web flow
      webLogin()
        .then(async (loggedInUser) => {
          const wsList = await api.listWorkspaces();
          qc.setQueryData(workspaceKeys.list(), wsList);
          const onboarded = loggedInUser.onboarded_at != null;

          // 1. nextUrl wins: a `next=/invite/<id>` always survives the OAuth
          //    round-trip — the user clicked a specific link and we should
          //    honor exactly that destination.
          if (nextUrl) {
            router.push(nextUrl);
            return;
          }

          // 2. Un-onboarded users may have pending invitations on their
          //    email even when no `next=` was carried (came from a fresh
          //    login on marvis.ai instead of clicking the email link,
          //    or `state` was lost across the round-trip). Look them up by
          //    email and route to the batch /invitations page if any.
          //    Already-onboarded users skip this lookup — their new invites
          //    surface in the sidebar dropdown, not as a forced wall.
          if (!onboarded) {
            try {
              const invites = await api.listMyInvitations();
              if (invites.length > 0) {
                qc.setQueryData(workspaceKeys.myInvitations(), invites);
                router.push(paths.invitations());
                return;
              }
            } catch {
              // Network blip on the invite lookup is non-fatal — fall through
              // to the normal post-auth destination so the user isn't stuck
              // on a blank callback screen. Worst case they land on
              // /onboarding and the sidebar will surface invites later.
            }
          }

          // 3. Default: hand off to the resolver (onboarding for users who
          //    haven't finished it, first workspace for returning users,
          //    /workspaces/new for onboarded users with zero workspaces).
          router.push(resolvePostAuthDestination(wsList, onboarded));
        })
        .catch((err) => {
          authLogger.error(`Web ${providerLabel} OAuth callback failed`, err);
          setError(callbackErrorFrom(err));
        });
    }
  }, [searchParams, isLark, loginWithGoogle, loginWithLark, router, qc]);

  const errorDescription = (() => {
    if (!error) return null;
    switch (error.kind) {
      case "raw":
        return error.text;
      case "missing_code":
        return t(($) => $.web.callback.missing_code);
      case "access_denied":
        return t(($) => $.web.callback.access_denied);
      case "login_failed":
        return t(($) => $.web.callback.login_failed);
      case "account_disabled":
        return t(($) => $.web.callback.account_disabled);
      case "signup_prohibited":
        return t(($) => $.web.callback.signup_prohibited);
      case "email_not_allowed":
        return t(($) => $.web.callback.email_not_allowed);
      case "google_account_no_email":
        return t(($) => $.web.callback.google_account_no_email);
      case "oauth_code_invalid":
        return isLark
          ? t(($) => $.web.callback.lark_oauth_code_invalid)
          : t(($) => $.web.callback.oauth_code_invalid);
      case "lark_account_no_email":
        return t(($) => $.web.callback.lark_account_no_email);
      case "lark_tenant_not_allowed":
        return t(($) => $.web.callback.lark_tenant_not_allowed);
    }
  })();

  if (desktopToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.desktop_handoff.opening_title)}
            </CardTitle>
            <CardDescription>
              {t(($) => $.web.desktop_handoff.opening_description)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = `marvis://auth/callback?token=${encodeURIComponent(desktopToken)}`;
              }}
            >
              {t(($) => $.web.desktop_handoff.open_button)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.callback.failed_title)}
            </CardTitle>
            <CardDescription>
              {errorDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <a href={paths.login()} className="text-primary underline-offset-4 hover:underline">
              {t(($) => $.web.callback.back_to_login)}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-display-sm">
            {t(($) => $.web.callback.signing_in)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
