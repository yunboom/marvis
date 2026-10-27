import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  LARK_JSSDK_URL,
  LARK_LOGIN_SCOPE,
  isLarkClientUserAgent,
  requestLarkClientAuthCode,
  useLarkClientLogin,
} from "./use-lark-client-login";

type TestWindow = Window & { h5sdk?: unknown; tt?: unknown };

const LARK_UA =
  "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Lark/7.20.0 LarkLocale/zh_CN";

function stubSDK(tt: Record<string, unknown>) {
  const w = window as TestWindow;
  w.h5sdk = { ready: (cb: () => void) => cb(), error: vi.fn() };
  w.tt = tt;
}

describe("isLarkClientUserAgent", () => {
  it.each([
    [LARK_UA, true],
    ["Mozilla/5.0 Feishu/7.1.0", true],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36", false],
  ])("%s -> %s", (ua, expected) => {
    expect(isLarkClientUserAgent(ua)).toBe(expected);
  });
});

describe("requestLarkClientAuthCode", () => {
  afterEach(() => {
    const w = window as TestWindow;
    delete w.h5sdk;
    delete w.tt;
    document.head.querySelectorAll("script[data-lark-jssdk]").forEach((s) => s.remove());
  });

  it("returns the code from tt.requestAccess", async () => {
    const requestAccess = vi.fn((opts: { success: (r: { code: string }) => void }) =>
      opts.success({ code: "access-code" }),
    );
    stubSDK({ requestAccess });

    await expect(requestLarkClientAuthCode("cli_app")).resolves.toBe("access-code");
    expect(requestAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appID: "cli_app", scopeList: [LARK_LOGIN_SCOPE] }),
    );
  });

  it("falls back to tt.requestAuthCode when the client is too old", async () => {
    const requestAuthCode = vi.fn((opts: { success: (r: { code: string }) => void }) =>
      opts.success({ code: "legacy-code" }),
    );
    stubSDK({
      requestAccess: (opts: { fail: (e: { errno: number }) => void }) => opts.fail({ errno: 103 }),
      requestAuthCode,
    });

    await expect(requestLarkClientAuthCode("cli_app")).resolves.toBe("legacy-code");
    expect(requestAuthCode).toHaveBeenCalledWith(expect.objectContaining({ appId: "cli_app" }));
  });

  it("rejects on other requestAccess failures", async () => {
    const requestAuthCode = vi.fn();
    stubSDK({
      requestAccess: (opts: { fail: (e: { errno: number }) => void }) => opts.fail({ errno: 2 }),
      requestAuthCode,
    });

    await expect(requestLarkClientAuthCode("cli_app")).rejects.toThrow(/errno=2/);
    expect(requestAuthCode).not.toHaveBeenCalled();
  });

  it("loads the JSSDK script before asking for a code", async () => {
    const pending = requestLarkClientAuthCode("cli_app");
    const script = document.head.querySelector<HTMLScriptElement>("script[data-lark-jssdk]");
    expect(script?.src).toBe(LARK_JSSDK_URL);

    stubSDK({
      requestAccess: (opts: { success: (r: { code: string }) => void }) =>
        opts.success({ code: "loaded-code" }),
    });
    script?.dispatchEvent(new Event("load"));

    await expect(pending).resolves.toBe("loaded-code");
  });
});

describe("useLarkClientLogin", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LARK_UA);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const w = window as TestWindow;
    delete w.h5sdk;
    delete w.tt;
  });

  it("passes the client code to onCode and stays pending on success", async () => {
    stubSDK({
      requestAccess: (opts: { success: (r: { code: string }) => void }) =>
        opts.success({ code: "client-code" }),
    });
    const onCode = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useLarkClientLogin({ appId: "cli_app", enabled: true, onCode }),
    );

    expect(result.current).toBe(true);
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("client-code"));
    expect(result.current).toBe(true);
  });

  it("falls back to the form when sign-in fails", async () => {
    stubSDK({
      requestAccess: (opts: { success: (r: { code: string }) => void }) =>
        opts.success({ code: "client-code" }),
    });
    const onCode = vi.fn().mockRejectedValue(new Error("login failed"));

    const { result } = renderHook(() =>
      useLarkClientLogin({ appId: "cli_app", enabled: true, onCode }),
    );

    await waitFor(() => expect(result.current).toBe(false));
    expect(onCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["outside the Feishu client", "Mozilla/5.0 Chrome/120.0", "cli_app", true],
    ["without an app id", LARK_UA, undefined, true],
    ["when disabled", LARK_UA, "cli_app", false],
  ])("does nothing %s", async (_case, ua, appId, enabled) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    const requestAccess = vi.fn();
    stubSDK({ requestAccess });
    const onCode = vi.fn();

    const { result } = renderHook(() => useLarkClientLogin({ appId, enabled, onCode }));
    await act(async () => {});

    expect(result.current).toBe(false);
    expect(requestAccess).not.toHaveBeenCalled();
    expect(onCode).not.toHaveBeenCalled();
  });
});
