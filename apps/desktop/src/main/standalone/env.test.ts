// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  INTEGRATION_KEY_ENVS,
  type StandaloneSecrets,
  type StandaloneSettings,
} from "../../shared/standalone";
import { buildMigrateEnv, buildServerEnv, type ServerEnvInput } from "./env";

const DB_URL = "postgres://marvis:pw@127.0.0.1:15432/marvis";
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/me",
  LANG: "zh_CN.UTF-8",
  MARVIS_FOO: "leak",
  DATABASE_URL: "postgres://dev-shell/db",
  REDIS_URL: "redis://dev-shell",
  JWT_SECRET: "dev-shell-secret",
};

function makeInput(
  settingsOverrides: Partial<StandaloneSettings> = {},
  secretsOverrides: Partial<StandaloneSecrets> = {},
): ServerEnvInput {
  return {
    settings: { ...defaultStandaloneSettings("  My Mac  "), adminEmail: "a@example.com", ...settingsOverrides },
    secrets: { ...generateStandaloneSecrets(), ...secretsOverrides },
    databaseUrl: DB_URL,
    uploadsDir: "/data/uploads",
    bootstrapToken: "boot-token",
    baseEnv: BASE_ENV,
  };
}

describe("buildServerEnv", () => {
  it("sets the fixed and core variables", () => {
    const input = makeInput();
    const env = buildServerEnv(input);

    expect(env).toMatchObject({
      APP_ENV: "production",
      MARVIS_STANDALONE: "1",
      ALLOW_SIGNUP: "true",
      DO_NOT_TRACK: "1",
      MARVIS_APP_URL: "",
      DATABASE_URL: DB_URL,
      LOCAL_UPLOAD_DIR: "/data/uploads",
      PORT: "13840",
      MARVIS_LAN_NAME: "My Mac",
      JWT_SECRET: input.secrets.jwtSecret,
      MARVIS_BOOTSTRAP_TOKEN: "boot-token",
    });
    for (const key of INTEGRATION_KEY_ENVS) expect(env[key]).toBe(input.secrets.integrationKeys[key]);
  });

  it("copies only the allow-listed base variables and never sets REDIS_URL", () => {
    const env = buildServerEnv(makeInput());

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/me");
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env).not.toHaveProperty("MARVIS_FOO");
    expect(env).not.toHaveProperty("REDIS_URL");
    expect(env).not.toHaveProperty("USERPROFILE");
    expect(env.DATABASE_URL).toBe(DB_URL);
    expect(env.JWT_SECRET).not.toBe("dev-shell-secret");
  });

  it.each([
    [false, "127.0.0.1", "false"],
    [true, "", "true"],
  ])("lanEnabled=%s sets listen host %j and discovery %s", (lanEnabled, host, discovery) => {
    const env = buildServerEnv(makeInput({ lanEnabled }));

    expect(env.MARVIS_LISTEN_HOST).toBe(host);
    expect(env.MARVIS_LAN_DISCOVERY).toBe(discovery);
  });

  it.each([
    [true, "654321"],
    [false, undefined],
  ])("loginCodeEnabled=%s sets the verification code to %s", (loginCodeEnabled, expected) => {
    const env = buildServerEnv(makeInput({ loginCodeEnabled }, { loginCode: "654321" }));

    expect(env.MARVIS_DEV_VERIFICATION_CODE).toBe(expected);
    if (expected === undefined) expect(env).not.toHaveProperty("MARVIS_DEV_VERIFICATION_CODE");
  });

  it.each<[string, Partial<StandaloneSettings>, Record<string, string | undefined>]>([
    [
      "Lark off",
      { lark: { appId: " ", tenantKeys: "t1" } },
      {
        MARVIS_LARK_LOGIN_APP_ID: undefined,
        MARVIS_LARK_LOGIN_APP_SECRET: undefined,
        MARVIS_LARK_LOGIN_TENANT_KEYS: undefined,
        MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI: undefined,
      },
    ],
    [
      "Lark on, LAN off, no tenants",
      { port: 14000, lark: { appId: " cli_abc ", tenantKeys: "" } },
      {
        MARVIS_LARK_LOGIN_APP_ID: "cli_abc",
        MARVIS_LARK_LOGIN_APP_SECRET: "lark-secret",
        MARVIS_LARK_LOGIN_TENANT_KEYS: undefined,
        MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI: "http://localhost:14000/auth/lark/desktop-callback",
      },
    ],
    [
      "Lark on, LAN on, tenants",
      { lanEnabled: true, lark: { appId: "cli_abc", tenantKeys: " t1,t2 " } },
      {
        MARVIS_LARK_LOGIN_APP_ID: "cli_abc",
        MARVIS_LARK_LOGIN_APP_SECRET: "lark-secret",
        MARVIS_LARK_LOGIN_TENANT_KEYS: "t1,t2",
        MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI: undefined,
      },
    ],
  ])("%s", (_name, settings, expected) => {
    const env = buildServerEnv(makeInput(settings, { larkAppSecret: "lark-secret" }));

    for (const [key, value] of Object.entries(expected)) expect(env[key], key).toBe(value);
  });

  it.each<[string, Partial<StandaloneSettings>, string, Record<string, string | undefined>]>([
    [
      "SMTP off",
      { smtp: { host: "", port: 465, username: "u", fromEmail: "f@x.com" } },
      "pw",
      { SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USERNAME: undefined, SMTP_PASSWORD: undefined, SMTP_FROM_EMAIL: undefined },
    ],
    [
      "SMTP on, all fields",
      { smtp: { host: " smtp.x.com ", port: 465, username: " u ", fromEmail: "f@x.com" } },
      "pw",
      { SMTP_HOST: "smtp.x.com", SMTP_PORT: "465", SMTP_USERNAME: "u", SMTP_PASSWORD: "pw", SMTP_FROM_EMAIL: "f@x.com" },
    ],
    [
      "SMTP on, optional fields empty",
      { smtp: { host: "smtp.x.com", port: 25, username: "", fromEmail: "" } },
      "",
      { SMTP_HOST: "smtp.x.com", SMTP_PORT: "25", SMTP_USERNAME: undefined, SMTP_PASSWORD: undefined, SMTP_FROM_EMAIL: undefined },
    ],
  ])("%s", (_name, settings, smtpPassword, expected) => {
    const env = buildServerEnv(makeInput(settings, { smtpPassword }));

    for (const [key, value] of Object.entries(expected)) expect(env[key], key).toBe(value);
  });

  it.each<[string, StandaloneSettings["llm"], string, Record<string, string | undefined>]>([
    [
      "LLM off",
      { baseUrl: "", model: "" },
      "",
      { MARVIS_LLM_BASE_URL: undefined, MARVIS_LLM_DEFAULT_MODEL: undefined, MARVIS_LLM_API_KEY: undefined },
    ],
    [
      "LLM all set",
      { baseUrl: " https://llm.x.com/v1 ", model: "gpt" },
      "key",
      { MARVIS_LLM_BASE_URL: "https://llm.x.com/v1", MARVIS_LLM_DEFAULT_MODEL: "gpt", MARVIS_LLM_API_KEY: "key" },
    ],
    [
      "LLM key only",
      { baseUrl: "", model: "" },
      "key",
      { MARVIS_LLM_BASE_URL: undefined, MARVIS_LLM_DEFAULT_MODEL: undefined, MARVIS_LLM_API_KEY: "key" },
    ],
  ])("%s", (_name, llm, llmApiKey, expected) => {
    const env = buildServerEnv(makeInput({ llm }, { llmApiKey }));

    for (const [key, value] of Object.entries(expected)) expect(env[key], key).toBe(value);
  });
});

describe("buildMigrateEnv", () => {
  it("copies the allow-list and sets only DATABASE_URL", () => {
    const env = buildMigrateEnv(DB_URL, BASE_ENV);

    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/me", LANG: "zh_CN.UTF-8", DATABASE_URL: DB_URL });
  });
});
