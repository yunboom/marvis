// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  INTEGRATION_KEY_ENVS,
  VALIDATION_EMAIL,
  VALIDATION_JWT_LENGTH,
  VALIDATION_KEY_FORMAT,
  VALIDATION_LARK_APP_ID,
  VALIDATION_LARK_SECRET_REQUIRED,
  VALIDATION_LOGIN_CODE,
  VALIDATION_PORT_RANGE,
  VALIDATION_REQUIRED,
  VALIDATION_TENANT_KEYS,
  VALIDATION_URL,
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  isIntegrationKey,
  randomHexSecret,
  randomIntegrationKey,
  randomLoginCode,
  standalonePlatformKey,
  validateStandaloneSetup,
  type StandaloneSetupInput,
} from "./standalone";

function validInput(): StandaloneSetupInput {
  const settings = defaultStandaloneSettings("studio");
  settings.adminEmail = "admin@example.com";
  return { settings, secrets: generateStandaloneSecrets() };
}

describe("standalonePlatformKey", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-amd64"],
    ["linux", "arm64", "linux-arm64"],
    ["win32", "x64", "windows-amd64"],
    ["win32", "arm64", "windows-arm64"],
    ["freebsd", "x64", null],
    ["linux", "ia32", null],
  ] as const)("%s/%s -> %s", (platform, arch, want) => {
    expect(standalonePlatformKey(platform, arch)).toBe(want);
  });
});

describe("random secrets", () => {
  it("generates values the validation accepts", () => {
    expect(randomHexSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(isIntegrationKey(randomIntegrationKey())).toBe(true);
    expect(randomLoginCode()).toMatch(/^\d{6}$/);
    expect(validateStandaloneSetup(validInput())).toEqual({});
  });

  it("generates a key per integration and the default login code", () => {
    const secrets = generateStandaloneSecrets();
    expect(Object.keys(secrets.integrationKeys).sort()).toEqual([...INTEGRATION_KEY_ENVS].sort());
    expect(secrets.loginCode).toBe("888888");
  });
});

describe("isIntegrationKey", () => {
  it.each([
    ["q3Vt9Yx2LmP0aB7cD8eF1gH4iJ5kL6mN7oP8qR9sT0U=", true],
    ["my-vcs-key", false],
    ["q3Vt9Yx2LmP0aB7cD8eF1gH4iJ5kL6mN7oP8qR9sT0U", false],
    ["q3Vt9Yx2LmP0aB7cD8eF1gH4iJ5kL6mN7oP8qR9sT0U==", false],
  ])("%s -> %s", (value, want) => {
    expect(isIntegrationKey(value)).toBe(want);
  });
});

describe("validateStandaloneSetup", () => {
  type Mutate = (i: StandaloneSetupInput) => void;
  it.each<[string, Mutate, string, string]>([
    ["empty admin email", (i) => (i.settings.adminEmail = ""), "settings.adminEmail", VALIDATION_REQUIRED],
    ["bad admin email", (i) => (i.settings.adminEmail = "admin@"), "settings.adminEmail", VALIDATION_EMAIL],
    ["empty name", (i) => (i.settings.name = "  "), "settings.name", VALIDATION_REQUIRED],
    ["port too low", (i) => (i.settings.port = 80), "settings.port", VALIDATION_PORT_RANGE],
    ["short jwt", (i) => (i.secrets.jwtSecret = "short"), "secrets.jwtSecret", VALIDATION_JWT_LENGTH],
    [
      "bad vcs key",
      (i) => (i.secrets.integrationKeys.MARVIS_VCS_SECRET_KEY = "my-vcs-key"),
      "secrets.integrationKeys.MARVIS_VCS_SECRET_KEY",
      VALIDATION_KEY_FORMAT,
    ],
    ["empty login code", (i) => (i.secrets.loginCode = ""), "secrets.loginCode", VALIDATION_REQUIRED],
    ["5-digit login code", (i) => (i.secrets.loginCode = "12345"), "secrets.loginCode", VALIDATION_LOGIN_CODE],
    ["lark app id prefix", (i) => (i.settings.lark.appId = "app_1"), "settings.lark.appId", VALIDATION_LARK_APP_ID],
    ["lark secret missing", (i) => (i.settings.lark.appId = "cli_abc"), "secrets.larkAppSecret", VALIDATION_LARK_SECRET_REQUIRED],
    ["tenant keys", (i) => (i.settings.lark.tenantKeys = "a, b"), "settings.lark.tenantKeys", VALIDATION_TENANT_KEYS],
    ["smtp port", (i) => (i.settings.smtp.host = "smtp.example.com"), "settings.smtp.port", VALIDATION_PORT_RANGE],
    ["llm url", (i) => (i.settings.llm.baseUrl = "not a url"), "settings.llm.baseUrl", VALIDATION_URL],
  ])("%s", (_label, mutate, field, code) => {
    const input = validInput();
    mutate(input);
    expect(validateStandaloneSetup(input)).toMatchObject({ [field]: code });
  });

  it("skips the login code when the fixed code is off", () => {
    const input = validInput();
    input.settings.loginCodeEnabled = false;
    input.secrets.loginCode = "";
    expect(validateStandaloneSetup(input)).toEqual({});
  });
});
