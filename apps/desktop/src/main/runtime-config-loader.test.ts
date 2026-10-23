// @vitest-environment node
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import type { SelectedServer } from "../shared/server-discovery";
import { loadRuntimeConfig } from "./runtime-config-loader";
import { readSelectedServer, writeSelectedServer } from "./server-selection";

const selected: SelectedServer = {
  url: "http://marvis.local:13840",
  name: "设计部 Marvis",
  instanceId: "7f3a",
  source: "lan",
  appUrl: "",
};

async function makeDirs() {
  const dir = await mkdtemp(join(tmpdir(), "marvis-desktop-config-"));
  return { dir, userDataDir: join(dir, "userData"), configPath: join(dir, "desktop.json") };
}

describe("loadRuntimeConfig", () => {
  it("uses dev env and ignores server.json and desktop.json when VITE_API_URL is set in dev", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, apiUrl: "https://prod.example.com" }),
    );
    await writeSelectedServer(userDataDir, selected);

    await expect(
      loadRuntimeConfig({
        isDev: true,
        userDataDir,
        configPath,
        env: {
          apiUrl: "http://localhost:13840",
          wsUrl: "ws://localhost:13840/ws",
          appUrl: "http://localhost:3000",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "http://localhost:13840",
        wsUrl: "ws://localhost:13840/ws",
        appUrl: "http://localhost:3000",
      },
    });
  });

  it("reports an invalid VITE_API_URL in dev instead of falling through", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeSelectedServer(userDataDir, selected);

    const result = await loadRuntimeConfig({
      isDev: true,
      userDataDir,
      configPath,
      env: { apiUrl: "ftp://nope" },
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error.message");
  });

  it("falls through to server.json in dev when VITE_API_URL is not set", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeSelectedServer(userDataDir, selected);

    await expect(
      loadRuntimeConfig({ isDev: true, userDataDir, configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "http://marvis.local:13840",
        wsUrl: "ws://marvis.local:13840/ws",
        appUrl: "",
      },
    });
  });

  it("prefers server.json over desktop.json and reports unconfigured when neither exists", async () => {
    const { userDataDir, configPath } = await makeDirs();

    // 两份文件都不在：未配置
    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toEqual({ ok: false, unconfigured: true });

    // 只有 desktop.json：用它
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, apiUrl: "https://api.example.com" }),
    );
    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toMatchObject({ ok: true, config: { apiUrl: "https://api.example.com" } });

    // 两份都在：apiUrl 来自 server.json，appUrl 保持空串
    const withWebApp: SelectedServer = {
      ...selected,
      url: "http://192.168.1.20:13840",
      appUrl: "http://192.168.1.20:3000",
    };
    await writeSelectedServer(userDataDir, withWebApp);
    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "http://192.168.1.20:13840",
        wsUrl: "ws://192.168.1.20:13840/ws",
        appUrl: "http://192.168.1.20:3000",
      },
    });

    // server.json 写入后再读出是同一个对象
    expect(await readSelectedServer(userDataDir)).toEqual(withWebApp);
  });

  it("keeps an empty appUrl when the selected server has no web app", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeSelectedServer(userDataDir, selected);

    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toMatchObject({ ok: true, config: { appUrl: "" } });
  });

  it("treats a corrupt server.json as not selected", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeSelectedServer(userDataDir, selected);
    await writeFile(join(userDataDir, "server.json"), "{");

    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toEqual({ ok: false, unconfigured: true });
  });

  it("parses a valid packaged desktop.json when no server was selected", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, apiUrl: "https://api.example.com" }),
    );

    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "https://api.example.com",
        wsUrl: "wss://api.example.com/ws",
        appUrl: "https://example.com",
      },
    });
  });

  it("fails closed when packaged desktop.json is invalid", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeFile(configPath, "{");

    const result = await loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} });

    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error.message).toContain(configPath);
      expect(result.error.message).toContain("Invalid desktop runtime config JSON");
    } else {
      throw new Error("expected an error result");
    }
  });

  it("does not read desktop.json when server.json is present, even if desktop.json is invalid", async () => {
    const { userDataDir, configPath } = await makeDirs();
    await writeFile(configPath, "{");
    await writeSelectedServer(userDataDir, selected);

    await expect(
      loadRuntimeConfig({ isDev: false, userDataDir, configPath, env: {} }),
    ).resolves.toMatchObject({ ok: true, config: { apiUrl: "http://marvis.local:13840" } });
  });
});
