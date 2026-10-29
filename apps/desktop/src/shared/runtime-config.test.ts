// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deriveWsUrl,
  parseRuntimeConfig,
  runtimeConfigFromDevEnv,
  runtimeConfigFromServer,
} from "./runtime-config";

describe("runtime config", () => {
  it("derives https/wss compatible URLs from apiUrl", () => {
    expect(
      parseRuntimeConfig(
        JSON.stringify({
          schemaVersion: 1,
          apiUrl: "https://congvc-x99.taila6fa8a.ts.net:18443",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://congvc-x99.taila6fa8a.ts.net:18443",
      wsUrl: "wss://congvc-x99.taila6fa8a.ts.net:18443/ws",
      appUrl: "https://congvc-x99.taila6fa8a.ts.net:18443",
    });
  });

  it("strips the leading api. label when deriving appUrl", () => {
    expect(
      parseRuntimeConfig(
        JSON.stringify({ schemaVersion: 1, apiUrl: "https://api.marvis.ai" }),
      ),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://api.marvis.ai",
      wsUrl: "wss://api.marvis.ai/ws",
      appUrl: "https://marvis.ai",
    });
  });

  it("derives ws for http api URLs", () => {
    expect(deriveWsUrl("http://localhost:13840")).toBe("ws://localhost:13840/ws");
  });

  it("accepts explicit appUrl and wsUrl", () => {
    expect(
      parseRuntimeConfig(
        JSON.stringify({
          schemaVersion: 1,
          apiUrl: "https://api.example.com/",
          wsUrl: "wss://ws.example.com/socket/",
          appUrl: "https://app.example.com/",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://api.example.com",
      wsUrl: "wss://ws.example.com/socket",
      appUrl: "https://app.example.com",
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRuntimeConfig("{")).toThrow(/Invalid desktop runtime config JSON/);
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parseRuntimeConfig(JSON.stringify({ schemaVersion: 2, apiUrl: "https://api.example.com" })),
    ).toThrow(/schemaVersion/);
  });

  it("rejects non-http api schemes", () => {
    expect(() =>
      parseRuntimeConfig(JSON.stringify({ schemaVersion: 1, apiUrl: "file:///tmp/marvis" })),
    ).toThrow(/apiUrl must use http or https/);
  });

  it("rejects non-ws websocket schemes", () => {
    expect(() =>
      parseRuntimeConfig(
        JSON.stringify({
          schemaVersion: 1,
          apiUrl: "https://api.example.com",
          wsUrl: "https://api.example.com/ws",
        }),
      ),
    ).toThrow(/wsUrl must use ws or wss/);
  });

  it("preserves electron-vite dev env precedence", () => {
    expect(
      runtimeConfigFromDevEnv({
        apiUrl: "http://dev-api.example.test:8080/",
        wsUrl: "ws://dev-api.example.test:8080/ws/",
        appUrl: "http://dev-app.example.test:3000/",
      }),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "http://dev-api.example.test:8080",
      wsUrl: "ws://dev-api.example.test:8080/ws",
      appUrl: "http://dev-app.example.test:3000",
    });
  });

  it("falls back to local web URL when dev apiUrl is localhost", () => {
    expect(runtimeConfigFromDevEnv({ apiUrl: "http://localhost:13840" })).toEqual({
      schemaVersion: 1,
      apiUrl: "http://localhost:13840",
      wsUrl: "ws://localhost:13840/ws",
      appUrl: "http://localhost:3000",
    });
  });

  it("derives dev appUrl by stripping the leading api. label", () => {
    // When the dev renderer is pointed at a remote backend (e.g. a test
    // environment), copy-link / share URLs must reflect that environment's
    // public web host, not the api host. Marvis's convention exposes the
    // api at `api.<web-host>`, so stripping the leading label gives the
    // right web origin without a separate VITE_APP_URL.
    expect(
      runtimeConfigFromDevEnv({ apiUrl: "https://api.test.marvis.ai" }),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://api.test.marvis.ai",
      wsUrl: "wss://api.test.marvis.ai/ws",
      appUrl: "https://test.marvis.ai",
    });
  });

  it("dev VITE_APP_URL still wins over apiUrl-derived value", () => {
    expect(
      runtimeConfigFromDevEnv({
        apiUrl: "https://api.test.marvis.ai",
        appUrl: "https://staging.marvis.ai",
      }),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://api.test.marvis.ai",
      wsUrl: "wss://api.test.marvis.ai/ws",
      appUrl: "https://staging.marvis.ai",
    });
  });

  it("builds a config from the selected server", () => {
    expect(
      runtimeConfigFromServer({
        url: "https://m.example.com:8443",
        name: "设计部 Marvis",
        instanceId: "7f3a",
        source: "manual",
        appUrl: "",
      }),
    ).toEqual({
      schemaVersion: 1,
      apiUrl: "https://m.example.com:8443",
      wsUrl: "wss://m.example.com:8443/ws",
      appUrl: "",
    });
  });

  it("keeps the /marvis prefix for the API, WebSocket and web login of the cloud server", () => {
    const config = runtimeConfigFromServer({
      url: "https://omniai.shoplazza.site/marvis",
      name: "prod",
      instanceId: "cloud",
      source: "manual",
      appUrl: "https://omniai.shoplazza.site/marvis",
    });

    expect(config).toEqual({
      schemaVersion: 1,
      apiUrl: "https://omniai.shoplazza.site/marvis",
      wsUrl: "wss://omniai.shoplazza.site/marvis/ws",
      appUrl: "https://omniai.shoplazza.site/marvis",
    });
    // 登录页（含飞书登录）在浏览器里打开 `${appUrl}/login`。
    expect(`${config.appUrl}/login`).toBe("https://omniai.shoplazza.site/marvis/login");
  });
});
