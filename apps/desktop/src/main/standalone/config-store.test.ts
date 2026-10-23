// @vitest-environment node
import { mkdtemp, readFile, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  INTEGRATION_KEY_ENVS,
  type StandaloneSecrets,
  type StandaloneSettings,
} from "../../shared/standalone";
import {
  mergeSecrets,
  readSecrets,
  readStateFile,
  SecretStorageUnavailableError,
  writeSecrets,
  writeStateFile,
  type SecretCodec,
  type StandaloneStateFile,
} from "./config-store";

const CODEC_PREFIX = "enc:";

// 可逆的假编解码器：前缀 + base64，落盘内容不含明文。
function fakeCodec(available = true): SecretCodec {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(CODEC_PREFIX + Buffer.from(plain, "utf-8").toString("base64"), "utf-8"),
    decrypt: (data) => {
      const text = data.toString("utf-8");
      if (!text.startsWith(CODEC_PREFIX)) throw new Error("bad ciphertext");
      return Buffer.from(text.slice(CODEC_PREFIX.length), "base64").toString("utf-8");
    },
  };
}

function sampleState(): StandaloneStateFile {
  const settings = defaultStandaloneSettings("my-mac");
  settings.adminEmail = "admin@example.com";
  settings.smtp = { host: "smtp.example.com", port: 465, username: "u", fromEmail: "f@example.com" };

  return {
    settings,
    locked: true,
    serverVersion: "1.2.3",
    previousServerVersion: null,
    postgresVersion: "17.2",
    installedAt: "2026-10-24T00:00:00.000Z",
    autoDownloadUpdates: false,
  };
}

describe("state file", () => {
  it("treats a state file without autoDownloadUpdates as enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standalone-state-"));
    const path = join(dir, "config.json");
    const { autoDownloadUpdates: _omitted, ...legacy } = sampleState();
    await writeFile(path, JSON.stringify(legacy), "utf-8");

    expect((await readStateFile(path))?.autoDownloadUpdates).toBe(true);
  });

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standalone-state-"));
  });

  it("round-trips and creates the parent directory", async () => {
    const path = join(dir, "nested", "deeper", "config.json");
    const state = sampleState();

    await writeStateFile(path, state);

    expect(await readStateFile(path)).toEqual(state);
  });

  it("returns null when the file is missing", async () => {
    expect(await readStateFile(join(dir, "missing.json"))).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, "{not json", "utf-8");

    expect(await readStateFile(path)).toBeNull();
  });

  it("ignores unknown extra keys", async () => {
    const path = join(dir, "config.json");
    const state = sampleState();
    await writeFile(path, JSON.stringify({ ...state, extra: 1, settings: { ...state.settings, junk: true } }), "utf-8");

    expect(await readStateFile(path)).toEqual(state);
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ["port as string", (raw) => ((raw.settings as Record<string, unknown>).port = "13840")],
    ["lanEnabled as string", (raw) => ((raw.settings as Record<string, unknown>).lanEnabled = "true")],
    ["smtp.port as string", (raw) => (((raw.settings as Record<string, unknown>).smtp as Record<string, unknown>).port = "465")],
    ["missing llm", (raw) => delete (raw.settings as Record<string, unknown>).llm],
    ["locked as number", (raw) => (raw.locked = 1)],
    ["serverVersion as number", (raw) => (raw.serverVersion = 1)],
    ["missing installedAt", (raw) => delete raw.installedAt],
    ["settings not an object", (raw) => (raw.settings = [])],
  ])("returns null for wrong field types: %s", async (_name, mutate) => {
    const path = join(dir, "config.json");
    const raw = JSON.parse(JSON.stringify(sampleState())) as Record<string, unknown>;
    mutate(raw);
    await writeFile(path, JSON.stringify(raw), "utf-8");

    expect(await readStateFile(path)).toBeNull();
  });
});

describe("secrets", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standalone-secrets-"));
    path = join(dir, "sub", "secrets.enc");
  });

  it("round-trips through the codec without writing plaintext", async () => {
    const secrets = { ...generateStandaloneSecrets(), larkAppSecret: "lark-s", smtpPassword: "p w", llmApiKey: "k" };

    await writeSecrets(path, secrets, fakeCodec());

    expect(await readSecrets(path, fakeCodec())).toEqual(secrets);
    const onDisk = await readFile(path, "utf-8");
    expect(onDisk).not.toContain(secrets.jwtSecret);
  });

  it("returns null when the file is missing", async () => {
    expect(await readSecrets(path, fakeCodec())).toBeNull();
  });

  it("returns null when decryption fails", async () => {
    await writeSecrets(path, generateStandaloneSecrets(), fakeCodec());
    await writeFile(path, "garbage", "utf-8");

    expect(await readSecrets(path, fakeCodec())).toBeNull();
  });

  it("returns null when an integration key is missing", async () => {
    const secrets = generateStandaloneSecrets();
    const keys: Record<string, string> = { ...secrets.integrationKeys };
    delete keys[INTEGRATION_KEY_ENVS[3]];
    const plainPath = join(dir, "secrets.enc");
    await writeFile(plainPath, fakeCodec().encrypt(JSON.stringify({ ...secrets, integrationKeys: keys })));

    expect(await readSecrets(plainPath, fakeCodec())).toBeNull();
  });

  it("returns null when a field has the wrong type", async () => {
    const plainPath = join(dir, "secrets.enc");
    await writeFile(plainPath, fakeCodec().encrypt(JSON.stringify({ ...generateStandaloneSecrets(), llmApiKey: 1 })));

    expect(await readSecrets(plainPath, fakeCodec())).toBeNull();
  });

  it("throws SecretStorageUnavailableError and writes nothing when the codec is unavailable", async () => {
    await expect(writeSecrets(path, generateStandaloneSecrets(), fakeCodec(false))).rejects.toBeInstanceOf(
      SecretStorageUnavailableError,
    );
    expect(await readSecrets(path, fakeCodec())).toBeNull();
  });

  it.skipIf(process.platform === "win32")("writes the file with mode 0600", async () => {
    await writeSecrets(path, generateStandaloneSecrets(), fakeCodec());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("mergeSecrets", () => {
  const existing: StandaloneSecrets = {
    ...generateStandaloneSecrets(),
    larkAppSecret: "old-lark",
    smtpPassword: "old-smtp",
    llmApiKey: "old-llm",
  };
  const incoming: StandaloneSecrets = { ...generateStandaloneSecrets(), loginCode: "123456" };

  function settingsWith(overrides: Partial<StandaloneSettings> = {}): StandaloneSettings {
    return {
      ...defaultStandaloneSettings("host"),
      lark: { appId: "cli_abc", tenantKeys: "" },
      smtp: { host: "smtp.example.com", port: 465, username: "", fromEmail: "" },
      llm: { baseUrl: "https://llm.example.com", model: "m" },
      ...overrides,
    };
  }

  it("keeps the locked keys when locked and existing is present", () => {
    const merged = mergeSecrets(existing, incoming, true, settingsWith());

    expect(merged.jwtSecret).toBe(existing.jwtSecret);
    expect(merged.integrationKeys).toEqual(existing.integrationKeys);
    expect(merged.postgresPassword).toBe(existing.postgresPassword);
    expect(merged.loginCode).toBe("123456");
  });

  it.each<[string, StandaloneSecrets | null, boolean]>([
    ["unlocked with existing", existing, false],
    ["locked without existing", null, true],
  ])("takes incoming keys when %s", (_name, prev, locked) => {
    const merged = mergeSecrets(prev, incoming, locked, settingsWith());

    expect(merged.jwtSecret).toBe(incoming.jwtSecret);
    expect(merged.integrationKeys).toEqual(incoming.integrationKeys);
    expect(merged.postgresPassword).toBe(incoming.postgresPassword);
  });

  it("keeps existing optional secrets when incoming is empty", () => {
    const merged = mergeSecrets(existing, incoming, true, settingsWith());

    expect(merged.larkAppSecret).toBe("old-lark");
    expect(merged.smtpPassword).toBe("old-smtp");
    expect(merged.llmApiKey).toBe("old-llm");
  });

  it("takes non-empty incoming optional secrets", () => {
    const next = { ...incoming, larkAppSecret: "new-lark", smtpPassword: "new-smtp", llmApiKey: "new-llm" };
    const merged = mergeSecrets(existing, next, true, settingsWith());

    expect(merged.larkAppSecret).toBe("new-lark");
    expect(merged.smtpPassword).toBe("new-smtp");
    expect(merged.llmApiKey).toBe("new-llm");
  });

  it("returns empty optional secrets when there is no existing and incoming is empty", () => {
    const merged = mergeSecrets(null, incoming, false, settingsWith());

    expect(merged.larkAppSecret).toBe("");
    expect(merged.smtpPassword).toBe("");
    expect(merged.llmApiKey).toBe("");
  });

  it.each<[string, Partial<StandaloneSettings>, keyof StandaloneSecrets]>([
    ["lark appId cleared", { lark: { appId: "", tenantKeys: "" } }, "larkAppSecret"],
    ["smtp host cleared", { smtp: { host: " ", port: null, username: "", fromEmail: "" } }, "smtpPassword"],
    ["llm baseUrl and model cleared", { llm: { baseUrl: "", model: "" } }, "llmApiKey"],
  ])("clears the optional secret when %s", (_name, overrides, field) => {
    const next = { ...incoming, larkAppSecret: "x", smtpPassword: "x", llmApiKey: "x" };

    expect(mergeSecrets(existing, next, true, settingsWith(overrides))[field]).toBe("");
    expect(mergeSecrets(existing, incoming, true, settingsWith(overrides))[field]).toBe("");
  });

  it("keeps the llm key when only one of baseUrl/model is cleared", () => {
    const merged = mergeSecrets(existing, incoming, true, settingsWith({ llm: { baseUrl: "", model: "m" } }));

    expect(merged.llmApiKey).toBe("old-llm");
  });
});
