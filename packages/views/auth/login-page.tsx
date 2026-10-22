"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@marvis/ui/components/ui/card";
import { Alert, AlertDescription } from "@marvis/ui/components/ui/alert";
import { Input } from "@marvis/ui/components/ui/input";
import { cn } from "@marvis/ui/lib/utils";
import { Button } from "@marvis/ui/components/ui/button";
import { Label } from "@marvis/ui/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@marvis/ui/components/ui/input-otp";
import { useAuthStore } from "@marvis/core/auth";
import { workspaceKeys } from "@marvis/core/workspace/queries";
import { api } from "@marvis/core/api";
import type { User } from "@marvis/core/types";
import { useT } from "../i18n";
import { LARK_LOGIN_SCOPE, useLarkClientLogin } from "./use-lark-client-login";

// Types

interface GoogleAuthConfig {
  clientId: string;
  redirectUri: string;
  /** Opaque state passed through Google OAuth (e.g. "platform:desktop"). */
  state?: string;
}

interface LarkAuthConfig {
  appId: string;
  redirectUri: string;
  /** 透传给飞书授权回调的 state，在 Google state 基础上多带 provider:lark。 */
  state?: string;
}

// 飞书授权 state 中标记登录方式的片段，回调页据此改调飞书登录接口。
export const LARK_PROVIDER_STATE = "provider:lark";

// 飞书网页授权地址（国内飞书）。
const LARK_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";

interface CliCallbackConfig {
  /** Validated localhost callback URL */
  url: string;
  /** Opaque state to pass back to CLI */
  state: string;
}

interface LoginPageProps {
  /** Logo element rendered above the title */
  logo?: ReactNode;
  /** Called after successful login. The workspace list is seeded into React
   *  Query before this fires, so the caller can compute a destination URL. */
  onSuccess: () => void;
  /** Google OAuth config. Omit to disable Google login. */
  google?: GoogleAuthConfig;
  /** CLI callback config for authorizing CLI tools. */
  cliCallback?: CliCallbackConfig;
  /** Called after a token is obtained (e.g. to set cookies). */
  onTokenObtained?: () => void;
  /** Override Google login handler (e.g. desktop opens browser externally). When provided, renders the Google button even if `google` config is omitted. */
  onGoogleLogin?: () => void;
  /** 飞书登录配置，省略则不显示飞书按钮；提供时在飞书客户端内自动免登。 */
  lark?: LarkAuthConfig;
  /** 覆盖飞书登录点击行为（如桌面端打开浏览器），提供时即使没有 `lark` 也显示飞书按钮。 */
  onLarkLogin?: () => void;
  /** Slot rendered at the bottom of the sign-in card, below the
   *  Google button. The web shell uses it for a "Prefer the desktop
   *  app?" prompt; desktop omits it (a download prompt inside the app
   *  would be absurd). */
  extra?: ReactNode;
}

// Helpers

export function redirectToCliCallback(url: string, token: string, state: string) {
  const separator = url.includes("?") ? "&" : "?";
  window.location.href = `${url}${separator}token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
}

/**
 * Validate that a CLI callback URL points to a safe host over HTTP.
 * Allows localhost and private/LAN IPs (RFC 1918) to support self-hosted setups
 * on local VMs while blocking arbitrary public hosts.
 */
export function validateCliCallback(cliCallback: string): boolean {
  try {
    const cbUrl = new URL(cliCallback);
    if (cbUrl.protocol !== "http:") return false;
    const h = cbUrl.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    // Allow RFC 1918 private IPs: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
    if (/^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

// 飞书品牌图标（多色），与 Google 图标同样内联。
function LarkIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12.9 11.2 15.5 8.6c.9-.9 1.9-1.6 3-2.1-.6-1.9-1.6-3.3-1.6-3.3s-.5-.2-1.1-.2H5.3c-.3 0-.4.3-.2.5 3.1 2.3 5.6 5.2 7.8 7.7z"
        fill="#00D6B9"
      />
      <path
        d="M23 9.5c-1.5-.7-3.2-.9-4.8-.5-1.1.3-2 .8-2.8 1.6l-1.6 1.6c-.7.7-1.4 1.3-2.2 1.9 0 0 1.6 1.6 4.3 1.6 1.7 0 2.8-.8 3.5-1.9L23 9.5z"
        fill="#133C9A"
      />
      <path
        d="M1 9.4v8.7c0 .1.1.3.2.3 1.8 1 3.9 1.6 6.1 1.6 3.4 0 6.5-1.3 8.8-3.6.2-.2-.1-.5-.3-.5-2.8.3-5.6-.8-8.2-2.8C5.6 12 3.3 10.5 1.4 9.1 1.2 9 1 9.2 1 9.4z"
        fill="#3370FF"
      />
    </svg>
  );
}

// Component

// Marvis-style auth surface, shared by every step of the flow.
const AUTH_SHELL_CLASS = "flex min-h-svh items-center justify-center bg-app-shell px-4";
// 卡片 420 宽、40 内边距、24 圆角；暗色去掉投影只留描边。
const AUTH_CARD_CLASS =
  "w-full max-w-[420px] gap-0 rounded-2xl border-0 p-10 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border has-data-[slot=card-footer]:pb-10 dark:shadow-none";
const AUTH_LOGO_CLASS = "mx-auto mb-4";
const AUTH_HEADER_CLASS = "gap-2 px-0 text-center";
const AUTH_TITLE_CLASS = "text-display-sm font-bold";
const AUTH_DESCRIPTION_CLASS = "text-body-lg";
const AUTH_FOOTER_CLASS = "border-t-0 bg-transparent p-0";
const AUTH_BUTTON_CLASS = "h-12 w-full text-body-lg";
// 弱按钮：浅灰底，44 高。
const AUTH_WEAK_BUTTON_CLASS = "h-11 w-full text-body-lg font-normal";
// 验证码格：48×56 填充底，聚焦位用主色描边。
const OTP_SLOT_CLASS =
  "h-14 w-12 rounded-lg border border-transparent bg-field text-title-lg font-semibold first:rounded-l-lg first:border-l last:rounded-r-lg data-[active=true]:border-foreground data-[active=true]:ring-0 dark:bg-field";

export function LoginPage({
  logo,
  onSuccess,
  google,
  cliCallback,
  onTokenObtained,
  onGoogleLogin,
  lark,
  onLarkLogin,
  extra,
}: LoginPageProps) {
  const { t } = useT("auth");
  const qc = useQueryClient();
  const [step, setStep] = useState<"email" | "code" | "cli_confirm">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [existingUser, setExistingUser] = useState<User | null>(null);
  // Tracks how the existing session was detected so handleCliAuthorize
  // uses the matching token source (cookie → issueCliToken, localStorage → direct).
  const authSourceRef = useRef<"cookie" | "localStorage">("cookie");
  // The last session ended because the server rejected its credential, not
  // because the user asked to leave. Without saying so, landing here reads as
  // the app having lost their work for no reason.
  const sessionExpired = useAuthStore((state) => state.expired);
  const authStatus = useAuthStore((state) => state.status);

  // Check for existing session when CLI callback is present.
  // Prioritises cookie auth (= current browser session) to avoid authorising
  // the CLI with a stale or mismatched localStorage token.
  useEffect(() => {
    if (!cliCallback) return;

    // Snapshot the token before probing. The probe below is *expected* to 401
    // for a token-mode session, and a 401 ends the session — clearing this
    // very key — so reading it after the probe would always come back null
    // and the fallback could never run.
    const storedToken = localStorage.getItem("marvis_token");

    // Ensure no stale bearer token interferes — we want to test the cookie first.
    api.setToken(null);

    api
      .getMe()
      .then((user) => {
        authSourceRef.current = "cookie";
        setExistingUser(user);
        setStep("cli_confirm");
      })
      .catch(() => {
        // Cookie auth failed — fall back to the token this browser had.
        if (!storedToken) return;

        localStorage.setItem("marvis_token", storedToken);
        api.setToken(storedToken);
        api
          .getMe()
          .then((user) => {
            authSourceRef.current = "localStorage";
            setExistingUser(user);
            setStep("cli_confirm");
          })
          .catch(() => {
            api.setToken(null);
            localStorage.removeItem("marvis_token");
          });
      });
  }, [cliCallback]);

  // Cooldown timer for resend
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleSendCode = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!email) {
        setError(t(($) => $.common.email_required));
        return;
      }
      setLoading(true);
      setError("");
      try {
        await useAuthStore.getState().sendCode(email);
        setStep("code");
        setCode("");
        setCooldown(60);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : `${t(($) => $.errors.send_failed)} ${t(($) => $.errors.server_unreachable)}`,
        );
      } finally {
        setLoading(false);
      }
    },
    [email, t],
  );

  // Normal path: seed the workspace list into the Query cache so the
  // caller's onSuccess can read it synchronously to compute a destination
  // URL (first workspace's slug, or /workspaces/new for zero-workspace
  // users). 验证码登录与飞书免登共用。
  const finishLogin = useCallback(async () => {
    const wsList = await api.listWorkspaces();
    qc.setQueryData(workspaceKeys.list(), wsList);
    onTokenObtained?.();
    onSuccess();
  }, [onSuccess, onTokenObtained, qc]);

  const handleLarkClientCode = useCallback(
    async (larkCode: string) => {
      await useAuthStore.getState().loginWithLark(larkCode, "", "client");
      await finishLogin();
    },
    [finishLogin],
  );

  // 飞书客户端内免登：只在未登录、非 CLI 授权时尝试。
  const larkClientPending = useLarkClientLogin({
    appId: lark?.appId,
    enabled: !cliCallback && authStatus === "unauthenticated",
    onCode: handleLarkClientCode,
  });

  const handleVerify = useCallback(
    async (value: string) => {
      if (value.length !== 6) return;
      setLoading(true);
      setError("");
      try {
        if (cliCallback) {
          // CLI path: get token directly for the redirect URL
          const { token } = await api.verifyCode(email, value);
          localStorage.setItem("marvis_token", token);
          api.setToken(token);
          onTokenObtained?.();
          redirectToCliCallback(cliCallback.url, token, cliCallback.state);
          return;
        }

        await useAuthStore.getState().verifyCode(email, value);
        await finishLogin();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t(($) => $.errors.code_invalid),
        );
        setCode("");
        setLoading(false);
      }
    },
    [email, cliCallback, onTokenObtained, finishLogin, t],
  );

  const handleResend = async () => {
    if (cooldown > 0) return;
    setError("");
    try {
      await useAuthStore.getState().sendCode(email);
      setCooldown(60);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t(($) => $.errors.resend_failed),
      );
    }
  };

  const handleCliAuthorize = async () => {
    if (!cliCallback) return;
    setLoading(true);

    try {
      let token: string;

      if (authSourceRef.current === "localStorage") {
        // Session was detected via localStorage — reuse that token directly.
        const stored = localStorage.getItem("marvis_token");
        if (!stored) throw new Error("token missing");
        token = stored;
      } else {
        // Session was detected via cookie — obtain a bearer token from the server.
        const res = await api.issueCliToken();
        token = res.token;
      }

      onTokenObtained?.();
      redirectToCliCallback(cliCallback.url, token, cliCallback.state);
    } catch {
      setError(t(($) => $.errors.cli_auth_failed));
      setExistingUser(null);
      setStep("email");
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    if (onGoogleLogin) {
      onGoogleLogin();
      return;
    }
    if (!google) return;
    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "select_account",
    });
    if (google.state) params.set("state", google.state);
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  };

  const handleLarkLogin = () => {
    if (onLarkLogin) {
      onLarkLogin();
      return;
    }
    if (!lark) return;
    const params = new URLSearchParams({
      client_id: lark.appId,
      redirect_uri: lark.redirectUri,
      scope: LARK_LOGIN_SCOPE,
    });
    if (lark.state) params.set("state", lark.state);
    window.location.href = `${LARK_AUTHORIZE_URL}?${params}`;
  };

  // 飞书客户端免登进行中

  if (larkClientPending) {
    return (
      <div className={AUTH_SHELL_CLASS}>
        <Card className={AUTH_CARD_CLASS}>
          <CardHeader className={AUTH_HEADER_CLASS}>
            {logo && <div className={AUTH_LOGO_CLASS}>{logo}</div>}
            <CardTitle className={AUTH_TITLE_CLASS}>
              {t(($) => $.signin.lark_client_signing_in)}
            </CardTitle>
          </CardHeader>
          <CardContent className="mt-8 flex justify-center px-0">
            <Loader2
              aria-hidden
              className="size-6 animate-spin text-muted-foreground"
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // CLI confirm step

  if (step === "cli_confirm" && existingUser) {
    return (
      <div className={AUTH_SHELL_CLASS}>
        <Card className={AUTH_CARD_CLASS}>
          <CardHeader className={AUTH_HEADER_CLASS}>
            {logo && <div className={AUTH_LOGO_CLASS}>{logo}</div>}
            <CardTitle className={AUTH_TITLE_CLASS}>
              {t(($) => $.cli.title)}
            </CardTitle>
            <CardDescription className={cn(AUTH_DESCRIPTION_CLASS, "leading-relaxed")}>
              {t(($) => $.cli.description, { email: existingUser.email })}
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-8 flex flex-col gap-3 px-0">
            <Button
              onClick={handleCliAuthorize}
              disabled={loading}
              className={AUTH_BUTTON_CLASS}
              size="lg"
            >
              {loading
                ? t(($) => $.cli.authorizing)
                : t(($) => $.cli.authorize)}
            </Button>
            <Button
              variant="secondary"
              className={AUTH_WEAK_BUTTON_CLASS}
              onClick={() => {
                setExistingUser(null);
                setStep("email");
              }}
            >
              {t(($) => $.cli.different_account)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Code verification step

  if (step === "code") {
    return (
      <div className={AUTH_SHELL_CLASS}>
        <Card className={AUTH_CARD_CLASS}>
          <CardHeader className={AUTH_HEADER_CLASS}>
            {logo && <div className={AUTH_LOGO_CLASS}>{logo}</div>}
            <CardTitle className={AUTH_TITLE_CLASS}>
              {t(($) => $.verify.title)}
            </CardTitle>
            <CardDescription className={AUTH_DESCRIPTION_CLASS}>
              {t(($) => $.verify.description, { email })}
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-8 flex flex-col items-center gap-4 px-0">
            <InputOTP
              autoFocus
              maxLength={6}
              value={code}
              onChange={(value) => {
                setCode(value);
                if (value.length === 6) handleVerify(value);
              }}
              disabled={loading}
            >
              <InputOTPGroup className="gap-2.5">
                <InputOTPSlot index={0} className={OTP_SLOT_CLASS} />
                <InputOTPSlot index={1} className={OTP_SLOT_CLASS} />
                <InputOTPSlot index={2} className={OTP_SLOT_CLASS} />
                <InputOTPSlot index={3} className={OTP_SLOT_CLASS} />
                <InputOTPSlot index={4} className={OTP_SLOT_CLASS} />
                <InputOTPSlot index={5} className={OTP_SLOT_CLASS} />
              </InputOTPGroup>
            </InputOTP>
            {error && (
              <p className="text-center text-body text-destructive">{error}</p>
            )}
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <button
                type="button"
                onClick={handleResend}
                disabled={cooldown > 0}
                className="text-foreground underline underline-offset-4 disabled:text-muted-foreground disabled:no-underline disabled:cursor-not-allowed"
              >
                {cooldown > 0
                  ? t(($) => $.verify.resend_cooldown, { seconds: cooldown })
                  : t(($) => $.verify.resend)}
              </button>
            </div>
          </CardContent>
          <CardFooter className={cn(AUTH_FOOTER_CLASS, "mt-7")}>
            <Button
              type="button"
              variant="secondary"
              className={AUTH_WEAK_BUTTON_CLASS}
              onClick={() => {
                setStep("email");
                setCode("");
                setError("");
              }}
            >
              {t(($) => $.common.back)}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // Email step

  return (
    <div className={AUTH_SHELL_CLASS}>
      <Card className={AUTH_CARD_CLASS}>
        <CardHeader className={AUTH_HEADER_CLASS}>
          {logo && <div className={AUTH_LOGO_CLASS}>{logo}</div>}
          <CardTitle className={AUTH_TITLE_CLASS}>
            {t(($) => $.signin.title)}
          </CardTitle>
          <CardDescription className={AUTH_DESCRIPTION_CLASS}>
            {t(($) => $.signin.description)}
          </CardDescription>
        </CardHeader>
        <CardContent
          className={cn("px-0", sessionExpired ? "mt-6 space-y-5" : "mt-8")}
        >
          {sessionExpired && (
            <Alert className="flex items-center gap-2.5 rounded-lg border-input bg-transparent px-3.5 py-3">
              <CircleAlert
                aria-hidden
                className="text-muted-foreground"
              />
              <AlertDescription className="text-body text-foreground">
                {t(($) => $.errors.session_expired)}
              </AlertDescription>
            </Alert>
          )}
          <form id="login-form" onSubmit={handleSendCode} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="login-email" className="text-body">{t(($) => $.common.email)}</Label>
              <Input
                id="login-email"
                type="email"
                placeholder={t(($) => $.common.email_placeholder)}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
                className="h-12 rounded-lg px-4 md:text-body-lg"
              />
            </div>
            {error && (
              <p className="text-body text-destructive">{error}</p>
            )}
          </form>
        </CardContent>
        <CardFooter className={cn(AUTH_FOOTER_CLASS, "mt-5 flex flex-col gap-3")}>
          <Button
            type="submit"
            form="login-form"
            className={AUTH_BUTTON_CLASS}
            size="lg"
            disabled={!email || loading}
          >
            {loading
              ? t(($) => $.signin.sending)
              : t(($) => $.signin.continue)}
          </Button>
          {(google || onGoogleLogin) && (
            <Button
              type="button"
              variant="outline"
              className={cn(AUTH_BUTTON_CLASS, "gap-2.5")}
              size="lg"
              onClick={handleGoogleLogin}
              disabled={loading}
            >
              <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              {t(($) => $.signin.google)}
            </Button>
          )}
          {(lark || onLarkLogin) && (
            <Button
              type="button"
              variant="outline"
              className={cn(AUTH_BUTTON_CLASS, "gap-2.5")}
              size="lg"
              onClick={handleLarkLogin}
              disabled={loading}
            >
              <LarkIcon />
              {t(($) => $.signin.lark)}
            </Button>
          )}
          {extra && <div className="w-full pt-2 text-center">{extra}</div>}
        </CardFooter>
      </Card>
    </div>
  );
}
