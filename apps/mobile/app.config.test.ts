// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigContext } from "expo/config";
import createConfig from "./app.config";

afterEach(() => vi.unstubAllEnvs());

describe("iOS scene lifecycle configuration", () => {
  it("resolves native presenters from the foregrounded scene", () => {
    const requireFromTest = createRequire(import.meta.url);
    const requireFromExpo = createRequire(requireFromTest.resolve("expo/package.json"));
    const modulesCoreRoot = dirname(
      requireFromExpo.resolve("expo-modules-core/package.json"),
    );
    const utilities = readFileSync(
      join(modulesCoreRoot, "ios", "Utilities", "Utilities.swift"),
      "utf8",
    );

    expect(utilities).toContain("return SceneGeometry.keyWindow()");
    expect(utilities).not.toContain(
      "UIApplication.shared.keyWindow?.rootViewController",
    );
  });

  it.each([
    [undefined, "Marvis (Dev)", "ai.marvis.mobile.dev"],
    ["development", "Marvis (Dev)", "ai.marvis.mobile.dev"],
    ["staging", "Marvis (Staging)", "ai.marvis.mobile.staging"],
    ["production", "Marvis", "ai.marvis.mobile"],
  ])("enables scene support for %s without changing app identity", (env, name, bundleIdentifier) => {
    vi.stubEnv("APP_ENV", env);
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_DEV", undefined);
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_STAGING", undefined);
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_PROD", undefined);
    const config = createConfig({ config: {} } as ConfigContext);

    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(bundleIdentifier);
    expect(config.scheme).toBe("marvis");
    expect(config.plugins).toContainEqual([
      "expo-build-properties",
      { ios: { buildReactNativeFromSource: true, enableSceneSupport: true } },
    ]);
  });

  it.each([
    ["development", "com.example.marvis.dev"],
    ["staging", "com.example.marvis.staging"],
    ["production", "com.example.marvis"],
  ])("preserves signing overrides for %s", (env, bundleIdentifier) => {
    vi.stubEnv("APP_ENV", env);
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_DEV", "com.example.marvis.dev");
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_STAGING", "com.example.marvis.staging");
    vi.stubEnv("EXPO_BUNDLE_IDENTIFIER_PROD", "com.example.marvis");
    vi.stubEnv("EXPO_APPLE_TEAM_ID", "ABCDE12345");

    const config = createConfig({ config: {} } as ConfigContext);
    expect(config.ios).toMatchObject({ bundleIdentifier, appleTeamId: "ABCDE12345" });
    expect(config.scheme).toBe("marvis");
  });
});
