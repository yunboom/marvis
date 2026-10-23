// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  LARK_DESKTOP_LOGIN_TTL_MS,
  buildLarkDesktopStartUrl,
  createLarkDesktopLogin,
} from "./lark-desktop-login";

const API_URL = "http://marvis.local:13840";
const NONCE = "n".repeat(43);
const OTHER_NONCE = "o".repeat(43);
const TOKEN = "header.payload.signature";

function callbackParams(params: Record<string, string>): URLSearchParams {
  return new URL(`marvis://auth/callback?${new URLSearchParams(params)}`).searchParams;
}

function setup(nonces: string[] = [NONCE]) {
  let now = 1_000_000;
  const queue = [...nonces];
  const openExternal = vi.fn();
  const login = createLarkDesktopLogin({
    openExternal,
    now: () => now,
    createNonce: () => queue.shift() ?? NONCE,
  });

  return {
    login,
    openExternal,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("buildLarkDesktopStartUrl", () => {
  it("points at the server's desktop-start address with the nonce", () => {
    expect(buildLarkDesktopStartUrl(API_URL, NONCE)).toBe(
      `${API_URL}/auth/lark/desktop-start?nonce=${NONCE}`,
    );
  });

  it("ignores trailing slashes on the server address", () => {
    expect(buildLarkDesktopStartUrl(`${API_URL}//`, NONCE)).toBe(
      `${API_URL}/auth/lark/desktop-start?nonce=${NONCE}`,
    );
  });
});

describe("createLarkDesktopLogin", () => {
  it("opens the server's desktop-start address in the browser", async () => {
    const { login, openExternal } = setup();

    await login.start(API_URL);

    expect(openExternal).toHaveBeenCalledWith(
      `${API_URL}/auth/lark/desktop-start?nonce=${NONCE}`,
    );
  });

  it("creates a URL-safe random nonce of the length the server accepts", async () => {
    const openExternal = vi.fn();
    const login = createLarkDesktopLogin({ openExternal });

    await login.start(API_URL);
    await login.start(API_URL);

    const nonces = openExternal.mock.calls.map(
      ([url]) => new URL(url as string).searchParams.get("nonce") ?? "",
    );
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("accepts the token once when the nonce matches the pending login", async () => {
    const { login } = setup();
    await login.start(API_URL);

    const params = callbackParams({ token: TOKEN, nonce: NONCE });

    expect(login.acceptCallback(params)).toBe(TOKEN);
    expect(login.acceptCallback(params)).toBeNull();
  });

  it("drops a token whose nonce does not match and keeps waiting for the real one", async () => {
    const { login } = setup();
    await login.start(API_URL);

    expect(login.acceptCallback(callbackParams({ token: "forged", nonce: OTHER_NONCE }))).toBeNull();
    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBe(TOKEN);
  });

  it("drops a token with an empty nonce", async () => {
    const { login } = setup();
    await login.start(API_URL);

    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: "" }))).toBeNull();
  });

  it("drops a token with a nonce when no login is pending", () => {
    const { login } = setup();

    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBeNull();
  });

  it("drops a token after the pending login expires", async () => {
    const { login, advance } = setup();
    await login.start(API_URL);

    advance(LARK_DESKTOP_LOGIN_TTL_MS);

    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBeNull();
  });

  it("accepts a token just before the pending login expires", async () => {
    const { login, advance } = setup();
    await login.start(API_URL);

    advance(LARK_DESKTOP_LOGIN_TTL_MS - 1);

    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBe(TOKEN);
  });

  it("keeps only the latest login pending", async () => {
    const { login } = setup([NONCE, OTHER_NONCE]);
    await login.start(API_URL);
    await login.start(API_URL);

    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBeNull();
    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: OTHER_NONCE }))).toBe(TOKEN);
  });

  it("passes through the web app's callback without a nonce", async () => {
    const { login } = setup();
    await login.start(API_URL);

    expect(login.acceptCallback(callbackParams({ token: TOKEN }))).toBe(TOKEN);
    // 旧流程不消耗待完成的飞书登录。
    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBe(TOKEN);
  });

  it("ignores a callback without a token", async () => {
    const { login } = setup();
    await login.start(API_URL);

    expect(login.acceptCallback(callbackParams({ nonce: NONCE }))).toBeNull();
    expect(login.acceptCallback(callbackParams({ token: TOKEN, nonce: NONCE }))).toBe(TOKEN);
  });
});
