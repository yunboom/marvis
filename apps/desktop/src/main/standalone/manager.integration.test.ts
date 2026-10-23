// @vitest-environment node
// 单机模式端到端：真实下载、解压、PostgreSQL、迁移、服务端与 bootstrap 登录。
// 需要本机打好的两个资源包（scripts/build-standalone-bundle.sh 与 scripts/repack-postgres.sh 的产物），
// 用 MARVIS_STANDALONE_E2E_BUNDLES 指向它们所在的目录；没设置时跳过。
import { createReadStream, readdirSync, statSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  standalonePlatformKey,
  type StandaloneAsset,
  type StandaloneManifest,
  type StandaloneStatus,
} from "../../shared/standalone";
import type { SecretCodec } from "./config-store";
import { StandaloneManager } from "./manager";
import { standaloneLayout } from "./paths";
import { findFreePort, isPortFree } from "./postgres";

const bundlesDir = process.env.MARVIS_STANDALONE_E2E_BUNDLES;
const platform = standalonePlatformKey(process.platform, process.arch);

const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(plain),
  decrypt: (data) => data.toString(),
};

function assetFor(dir: string, prefix: string, baseUrl: string): { asset: StandaloneAsset; version: string } {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(`${platform}.tar.xz`));
  if (!name) throw new Error(`no ${prefix} bundle for ${platform} in ${dir}`);
  const version = name.slice(prefix.length, -`-${platform}.tar.xz`.length);
  const sha256 = readFileSync(join(dir, `${name}.sha256`), "utf-8").trim().split(/\s+/)[0];
  return { asset: { name, size: statSync(join(dir, name)).size, sha256, urls: [`${baseUrl}/${name}`] }, version };
}

describe.skipIf(!bundlesDir || !platform)("standalone mode end to end", () => {
  let server: Server;

  afterAll(() => server?.close());

  it(
    "installs, starts, signs the admin in and stops",
    async () => {
      const dir = bundlesDir!;
      server = createServer((req, res) => {
        const file = join(dir, decodeURIComponent((req.url ?? "/").slice(1)));
        res.writeHead(200, { "Content-Length": statSync(file).size });
        createReadStream(file).pipe(res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

      const serverBundle = assetFor(dir, "marvis-server-", baseUrl);
      const postgresBundle = assetFor(dir, "marvis-postgres-", baseUrl);
      const manifest: StandaloneManifest = {
        schemaVersion: 1,
        version: serverBundle.version,
        minAppVersion: "0.0.0",
        server: { [platform!]: serverBundle.asset },
        postgres: { version: postgresBundle.version, assets: { [platform!]: postgresBundle.asset } },
      };

      const root = await mkdtemp(join(tmpdir(), "standalone-e2e-"));
      const statuses: StandaloneStatus[] = [];
      const tokens: string[] = [];
      const manager = new StandaloneManager({
        layout: standaloneLayout(root),
        platformKey: platform,
        appVersion: "99.0.0",
        manifestUrl: `${baseUrl}/server-manifest.json`,
        hostName: "e2e",
        baseEnv: process.env,
        codec,
        publish: (s) => statuses.push(s),
        lanAddress: () => null,
        selectStandaloneServer: async () => undefined,
        deliverToken: (t) => tokens.push(t),
        log: (m, extra) => console.log(`[standalone e2e] ${m}`, extra ?? ""),
        ops: { fetchManifest: async () => manifest },
      });
      await manager.init();

      const settings = defaultStandaloneSettings("e2e");
      settings.adminEmail = "admin@example.com";
      settings.port = await findFreePort();
      await manager.install({ settings, secrets: generateStandaloneSecrets() });

      const deadline = Date.now() + 240_000;
      while (manager.status().phase !== "running") {
        const s = manager.status();
        if (s.phase === "failed") throw new Error(`standalone failed: ${JSON.stringify(s.error)}`);
        if (Date.now() > deadline) throw new Error(`timed out in phase ${s.phase}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const localUrl = manager.status().localUrl!;
      expect(statuses.map((s) => s.phase)).toEqual(
        expect.arrayContaining(["downloading", "verifying", "installing", "starting", "running"]),
      );

      // 主机管理员经 bootstrap 登录。
      await manager.enter();
      expect(tokens).toHaveLength(1);
      const me = await fetch(`${localUrl}/api/me`, { headers: { Authorization: `Bearer ${tokens[0]}` } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { email: string }).email).toBe("admin@example.com");

      // 局域网成员用固定验证码登录。
      const post = (path: string, body: unknown) =>
        fetch(`${localUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post("/auth/send-code", { email: "colleague@example.com" })).status).toBe(200);
      expect((await post("/auth/verify-code", { email: "colleague@example.com", code: "888888" })).status).toBe(200);

      await manager.stop();
      expect(manager.status().phase).toBe("stopped");
      expect(await isPortFree(settings.port)).toBe(true);
    },
    300_000,
  );
});
