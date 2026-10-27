import { randomBytes } from "crypto";

/**
 * 没有网页端时的桌面端飞书登录。主进程生成一次性 nonce，用浏览器打开服务端的
 * desktop-start；服务端完成飞书授权后经深链 marvis://auth/callback?token=…&nonce=…
 * 回到桌面端，只有与待完成的 nonce 一致才接受凭证，用后作废。
 * 不带 nonce 的深链是网页端登录页跳回来的旧流程，照常接受。
 */

/** 服务端的桌面端飞书登录起点，与服务端 LarkDesktopStartPath 一致。 */
export const LARK_DESKTOP_START_PATH = "/auth/lark/desktop-start";

/** 一次飞书登录的有效期，与服务端 state 的有效期一致。 */
export const LARK_DESKTOP_LOGIN_TTL_MS = 10 * 60 * 1000;

// 32 字节随机数编码成 43 个 [A-Za-z0-9_-] 字符，落在服务端允许的 32–128 之间。
const NONCE_BYTES = 32;
const NONCE_PARAM = "nonce";
const TOKEN_PARAM = "token";

export interface LarkDesktopLoginDeps {
  /** 用浏览器打开地址，生产环境传 openExternalSafely。 */
  openExternal: (url: string) => Promise<void> | void;
  /** 当前时间（毫秒），默认 Date.now。 */
  now?: () => number;
  /** 生成 nonce，默认取加密随机数。 */
  createNonce?: () => string;
}

export interface LarkDesktopLogin {
  /** 生成新的 nonce（替换之前未完成的登录），用浏览器打开服务端的 desktop-start。 */
  start: (apiUrl: string) => Promise<void>;
  /** 从 marvis://auth/callback 的参数里取出可以派发的 token；不能接受时返回 null。 */
  acceptCallback: (params: URLSearchParams) => string | null;
}

interface PendingLogin {
  nonce: string;
  expiresAt: number;
}

/** 拼出服务端 desktop-start 的地址。 */
export function buildLarkDesktopStartUrl(apiUrl: string, nonce: string): string {
  const url = new URL(`${apiUrl.replace(/\/+$/, "")}${LARK_DESKTOP_START_PATH}`);
  url.searchParams.set(NONCE_PARAM, nonce);
  return url.toString();
}

function createRandomNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

export function createLarkDesktopLogin(deps: LarkDesktopLoginDeps): LarkDesktopLogin {
  const now = deps.now ?? Date.now;
  const createNonce = deps.createNonce ?? createRandomNonce;
  // 同一时间只有一次待完成的登录。
  let pending: PendingLogin | null = null;

  return {
    async start(apiUrl) {
      const nonce = createNonce();
      pending = { nonce, expiresAt: now() + LARK_DESKTOP_LOGIN_TTL_MS };
      await deps.openExternal(buildLarkDesktopStartUrl(apiUrl, nonce));
    },

    acceptCallback(params) {
      const token = params.get(TOKEN_PARAM);
      if (!token) return null;

      // 网页端登录页跳回来的旧流程不带 nonce。
      if (!params.has(NONCE_PARAM)) return token;

      // nonce 不一致时只丢弃这次的凭证，待完成的登录继续等待。
      const current = pending;
      if (!current || params.get(NONCE_PARAM) !== current.nonce) return null;

      pending = null;
      if (now() >= current.expiresAt) return null;

      return token;
    },
  };
}
