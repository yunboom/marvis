// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARVIS_CLOUD_SERVER_URL } from "../shared/server-discovery";
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

  it("waits up to 6000 ms for a .local host", async () => {
    vi.useFakeTimers();
    const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });

    const pending = probeServer("http://marvis.local:13840", hang as unknown as typeof fetch);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ kind: "unreachable" });
  });

  it("not_marvis when the body is larger than 1 MiB", async () => {
    const big = JSON.stringify({ instance_id: "b", pad: "x".repeat(1024 * 1024) });

    expect(
      (await probeServer("http://m:13840", async () => new Response(big))).kind,
    ).toBe("not_marvis");
  });

  it("not_marvis when the declared length is larger than 1 MiB, without reading the body", async () => {
    // 这个响应体永远读不完：只要去读它，测试就会超时。
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });

    expect(
      (
        await probeServer(
          "http://m:13840",
          async () => new Response(body, { headers: { "content-length": String(2 * 1024 * 1024) } }),
        )
      ).kind,
    ).toBe("not_marvis");
  });

  it("reads a body that fits within 1 MiB", async () => {
    const fits = JSON.stringify({ instance_id: "b", pad: "x".repeat(1024 * 1024 - 64) });

    expect((await probeServer("http://m:13840", async () => new Response(fits))).kind).toBe("ok");
  });

  it("strips control and bidi characters from the server identity", async () => {
    expect(
      await probeServer(
        "http://m:13840",
        json({
          server_name: "evil\u001b[2Jname\u202e",
          server_version: "0.6.5\n",
          instance_id: "inst\u0007-a",
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      server: { name: "evil[2Jname", version: "0.6.5", instanceId: "inst-a" },
    });
  });
});

describe("probeServer with a path in the address", () => {
  // 只有 `${base}/api/config` 命中 Marvis，其余路径都按 404 处理。
  function serverAt(base: string) {
    return vi.fn(async (input: RequestInfo | URL) =>
      String(input) === `${base}/api/config`
        ? new Response(JSON.stringify({ instance_id: "b" }))
        : new Response("not found", { status: 404 }),
    );
  }

  it("connects to a deployment under a path prefix", async () => {
    const fetchImpl = serverAt("https://shared.example/marvis");

    expect(
      await probeServer("https://shared.example/marvis/", fetchImpl as unknown as typeof fetch),
    ).toMatchObject({ kind: "ok", server: { url: "https://shared.example/marvis" } });
  });

  it("walks up from a pasted page URL to the server's base", async () => {
    const fetchImpl = serverAt("https://shared.example/marvis");

    expect(
      await probeServer(
        "https://shared.example/marvis/acme/issues/MUL-1",
        fetchImpl as unknown as typeof fetch,
      ),
    ).toMatchObject({ kind: "ok", server: { url: "https://shared.example/marvis" } });
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "https://shared.example/marvis/acme/issues/MUL-1/api/config",
      "https://shared.example/marvis/acme/issues/api/config",
      "https://shared.example/marvis/acme/api/config",
      "https://shared.example/marvis/api/config",
    ]);
  });

  it("resolves the Marvis cloud server through /api/config under its /marvis prefix", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "https://omniai.shoplazza.site/marvis/api/config"
        ? new Response(
            JSON.stringify({
              server_name: "prod",
              server_version: "v0.0.2",
              instance_id: "cloud",
              daemon_app_url: "https://omniai.shoplazza.site/marvis",
            }),
          )
        : new Response("not found", { status: 404 }),
    );

    expect(await probeServer(MARVIS_CLOUD_SERVER_URL, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "ok",
      server: {
        url: "https://omniai.shoplazza.site/marvis",
        name: "prod",
        version: "v0.0.2",
        instanceId: "cloud",
        host: "omniai.shoplazza.site",
        appUrl: "https://omniai.shoplazza.site/marvis",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the origin for a root deployment", async () => {
    const fetchImpl = serverAt("http://m:3000");

    expect(
      await probeServer("http://m:3000/login?x=1", fetchImpl as unknown as typeof fetch),
    ).toMatchObject({ kind: "ok", server: { url: "http://m:3000" } });
  });

  it("stops at an unreachable host instead of retrying every path", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    expect(
      await probeServer("http://m:3000/a/b", fetchImpl as unknown as typeof fetch),
    ).toEqual({ kind: "unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
