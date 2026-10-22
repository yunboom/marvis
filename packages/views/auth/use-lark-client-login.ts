"use client";

import { useEffect, useRef, useState } from "react";
import { createLogger } from "@marvis/core/logger";

// 飞书 H5 JSSDK，飞书客户端内免登时按需加载。
export const LARK_JSSDK_URL =
  "https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.26.js";

// 登录需要读取用户邮箱，网页授权与客户端免登都申请这一权限。
export const LARK_LOGIN_SCOPE = "contact:user.email:readonly";

// 飞书客户端 UA 中带有 Lark 或 Feishu 字样。
const LARK_CLIENT_USER_AGENT_PATTERN = /Lark|Feishu/i;

// tt.requestAccess 在旧版客户端上返回的 errno：客户端版本过低，需改用 tt.requestAuthCode。
const LARK_ERRNO_CLIENT_TOO_OLD = 103;

// JSSDK 加载或 ready 超时后放弃免登，回落到登录表单。
const LARK_SDK_READY_TIMEOUT_MS = 10_000;

const SCRIPT_MARKER_ATTRIBUTE = "data-lark-jssdk";

const logger = createLogger("auth.lark-client");

interface LarkAuthCodeResult {
  code: string;
}

interface LarkAuthCodeFailure {
  errno?: number;
  errString?: string;
  errMsg?: string;
}

interface LarkAuthCodeOptions {
  success: (res: LarkAuthCodeResult) => void;
  fail: (err: LarkAuthCodeFailure) => void;
}

interface LarkTT {
  requestAccess?: (
    options: LarkAuthCodeOptions & { appID: string; scopeList: string[] },
  ) => void;
  requestAuthCode?: (options: LarkAuthCodeOptions & { appId: string }) => void;
}

interface LarkH5SDK {
  ready: (callback: () => void) => void;
  error?: (callback: (err: unknown) => void) => void;
}

type LarkWindow = Window & { h5sdk?: LarkH5SDK; tt?: LarkTT };

/** isLarkClientUserAgent 判断当前页面是否运行在飞书客户端内。 */
export function isLarkClientUserAgent(userAgent: string): boolean {
  return LARK_CLIENT_USER_AGENT_PATTERN.test(userAgent);
}

/** loadLarkJSSDK 插入一次 JSSDK 脚本；已加载时直接返回。 */
export function loadLarkJSSDK(): Promise<void> {
  const larkWindow = window as LarkWindow;
  if (larkWindow.h5sdk) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(
      `script[${SCRIPT_MARKER_ATTRIBUTE}]`,
    );
    if (!script) {
      script = document.createElement("script");
      script.src = LARK_JSSDK_URL;
      script.async = true;
      script.setAttribute(SCRIPT_MARKER_ATTRIBUTE, "");
      document.head.appendChild(script);
    }

    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("failed to load Feishu JSSDK")),
      { once: true },
    );
  });
}

function describeLarkFailure(err: LarkAuthCodeFailure): string {
  return `errno=${err.errno ?? "unknown"} ${err.errString ?? err.errMsg ?? ""}`.trim();
}

// requestAuthCodeFromTT 优先用 tt.requestAccess；客户端过旧时改用 tt.requestAuthCode。
function requestAuthCodeFromTT(tt: LarkTT, appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      if (!tt.requestAuthCode) {
        reject(new Error("Feishu JSSDK has no requestAuthCode"));
        return;
      }
      tt.requestAuthCode({
        appId,
        success: (res) => resolve(res.code),
        fail: (err) =>
          reject(new Error(`Feishu requestAuthCode failed: ${describeLarkFailure(err)}`)),
      });
    };

    if (!tt.requestAccess) {
      fallback();
      return;
    }

    tt.requestAccess({
      appID: appId,
      scopeList: [LARK_LOGIN_SCOPE],
      success: (res) => resolve(res.code),
      fail: (err) => {
        if (err.errno === LARK_ERRNO_CLIENT_TOO_OLD) {
          fallback();
          return;
        }
        reject(new Error(`Feishu requestAccess failed: ${describeLarkFailure(err)}`));
      },
    });
  });
}

/** requestLarkClientAuthCode 在飞书客户端内静默获取登录授权码。 */
export async function requestLarkClientAuthCode(appId: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Feishu JSSDK did not become ready in time")),
      LARK_SDK_READY_TIMEOUT_MS,
    );
  });

  const ready = (async () => {
    await loadLarkJSSDK();

    const larkWindow = window as LarkWindow;
    const h5sdk = larkWindow.h5sdk;
    if (!h5sdk) throw new Error("Feishu JSSDK did not expose h5sdk");

    await new Promise<void>((resolve, reject) => {
      h5sdk.error?.((err) =>
        reject(new Error(`Feishu JSSDK error: ${JSON.stringify(err)}`)),
      );
      h5sdk.ready(() => resolve());
    });
  })();

  try {
    await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timer);
  }

  const tt = (window as LarkWindow).tt;
  if (!tt) throw new Error("Feishu JSSDK did not expose tt");

  return requestAuthCodeFromTT(tt, appId);
}

interface UseLarkClientLoginOptions {
  /** 飞书登录应用 App ID；为空时不免登。 */
  appId?: string;
  /** 外部条件（未登录、非 CLI 授权等）全部满足时为 true。 */
  enabled: boolean;
  /** 拿到授权码后完成登录；抛错时回落到登录表单。 */
  onCode: (code: string) => Promise<void>;
}

/**
 * useLarkClientLogin 在飞书客户端内自动免登，返回免登是否进行中。
 * 每次挂载最多尝试一次；失败只记日志，由调用方回落到登录表单。
 */
export function useLarkClientLogin({
  appId,
  enabled,
  onCode,
}: UseLarkClientLoginOptions): boolean {
  const shouldStart =
    enabled &&
    !!appId &&
    typeof navigator !== "undefined" &&
    isLarkClientUserAgent(navigator.userAgent);
  const [pending, setPending] = useState(shouldStart);
  const startedRef = useRef(false);
  const onCodeRef = useRef(onCode);

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    if (!shouldStart || !appId || startedRef.current) return;
    startedRef.current = true;
    setPending(true);

    requestLarkClientAuthCode(appId)
      .then((code) => onCodeRef.current(code))
      .catch((err) => {
        logger.warn("Feishu client sign-in failed, falling back to the login form", err);
        setPending(false);
      });
  }, [shouldStart, appId]);

  return pending;
}
