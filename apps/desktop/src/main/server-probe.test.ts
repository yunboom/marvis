// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeServer } from "./server-probe";

const json = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("probeServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ok", async () => {
    expect(
      await probeServer(
        "http://m:3000",
        json({
          server_name: "设计部 Marvis",
          server_version: "v0.6.5",
          instance_id: "7f3a",
          daemon_app_url: "http://localhost:3000",
        }),
      ),
    ).toEqual({
      kind: "ok",
      server: {
        url: "http://m:3000",
        name: "设计部 Marvis",
        version: "v0.6.5",
        instanceId: "7f3a",
        host: "m",
        appUrl: "",
      },
    });
  });

  it("requests /api/config on the given origin", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ instance_id: "b" })),
    );

    await probeServer("http://m:3000", fetchImpl as unknown as typeof fetch);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://m:3000/api/config");
  });

  it("keeps a non-loopback app url", async () => {
    expect(
      await probeServer(
        "http://m:13840",
        json({ server_name: "a", instance_id: "b", daemon_app_url: "http://marvis.local:3000" }),
      ),
    ).toMatchObject({ kind: "ok", server: { appUrl: "http://marvis.local:3000" } });
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("drops the loopback app url %s", async (daemonAppURL) => {
    expect(
      await probeServer("http://m:13840", json({ instance_id: "b", daemon_app_url: daemonAppURL })),
    ).toMatchObject({ kind: "ok", server: { appUrl: "" } });
  });

  it.each([undefined, "", "not a url", "ftp://m.example.com", 42])(
    "uses an empty app url for %j",
    async (daemonAppURL) => {
      expect(
        await probeServer("http://m:13840", json({ instance_id: "b", daemon_app_url: daemonAppURL })),
      ).toMatchObject({ kind: "ok", server: { appUrl: "" } });
    },
  );

  it("trims a trailing slash from the app url", async () => {
    expect(
      await probeServer(
        "http://m:13840",
        json({ instance_id: "b", daemon_app_url: "https://app.example.com/" }),
      ),
    ).toMatchObject({ kind: "ok", server: { appUrl: "https://app.example.com" } });
  });

  it("falls back to the host when the server name is empty or missing", async () => {
    expect(
      await probeServer("http://m:3000", json({ server_name: "  ", instance_id: "b" })),
    ).toMatchObject({ kind: "ok", server: { name: "m", version: "" } });
    expect(await probeServer("http://m:3000", json({ instance_id: "b" }))).toMatchObject({
      kind: "ok",
      server: { name: "m" },
    });
  });

  it("too_old", async () => {
    expect((await probeServer("http://m:3000", json({ allow_signup: true }))).kind).toBe("too_old");
  });

  it("too_old when instance_id is empty", async () => {
    expect((await probeServer("http://m:3000", json({ instance_id: "" }))).kind).toBe("too_old");
  });

  it("not_marvis on html", async () => {
    expect(
      (
        await probeServer(
          "http://m:3000",
          async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
        )
      ).kind,
    ).toBe("not_marvis");
  });

  it("not_marvis on a json body that is not an object", async () => {
    expect((await probeServer("http://m:3000", json([1, 2]))).kind).toBe("not_marvis");
    expect((await probeServer("http://m:3000", json(null))).kind).toBe("not_marvis");
  });

  it("not_marvis on 404", async () => {
    expect(
      (await probeServer("http://m:3000", async () => new Response("", { status: 404 }))).kind,
    ).toBe("not_marvis");
  });

  it("unreachable", async () => {
    expect(
      (
        await probeServer("http://m:3000", async () => {
          throw new TypeError("fetch failed");
        })
      ).kind,
    ).toBe("unreachable");
  });

  it("unreachable when the address is not an http url", async () => {
    const fetchImpl = vi.fn();

    expect((await probeServer("ftp://m", fetchImpl as unknown as typeof fetch)).kind).toBe(
      "unreachable",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unreachable after the 3000 ms timeout", async () => {
    vi.useFakeTimers();
    const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });

    const pending = probeServer("http://m:3000", hang as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ kind: "unreachable" });
  });
});
