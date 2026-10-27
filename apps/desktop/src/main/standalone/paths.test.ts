// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { standaloneLayout, standaloneRoot } from "./paths";

describe("standaloneRoot", () => {
  it("pins the production root to appData/Marvis/server", () => {
    expect(standaloneRoot("/AppData", { isDev: false, appName: "Renamed" })).toBe(join("/AppData", "Marvis", "server"));
  });

  it("keeps dev builds under their own app name", () => {
    expect(standaloneRoot("/AppData", { isDev: true, appName: "Marvis Canary wt1" })).toBe(
      join("/AppData", "Marvis Canary wt1", "server"),
    );
  });
});

describe("standaloneLayout", () => {
  it("places every path under the root", () => {
    const l = standaloneLayout("/root");
    expect(l.serverDir("0.6.6")).toBe(join("/root", "versions", "0.6.6"));
    expect(l.postgresDir("17.11.0")).toBe(join("/root", "postgres", "17.11.0"));
    expect(l.pgData).toBe(join("/root", "pgdata"));
    expect(l.stateFile).toBe(join("/root", "config.json"));
    expect(l.secretsFile).toBe(join("/root", "secrets.enc"));
    expect(l.serverPidFile).toBe(join("/root", "run", "server.pid"));
    expect(l.serverLog).toBe(join("/root", "logs", "server.log"));
    expect(l.postgresLog).toBe(join("/root", "logs", "postgres.log"));
    expect(l.download("a.tar.xz")).toBe(join("/root", "downloads", "a.tar.xz"));
  });

  it("refuses version strings that would escape the root", () => {
    const l = standaloneLayout("/root");
    expect(() => l.serverDir("../x")).toThrow();
    expect(() => l.postgresDir("a/b")).toThrow();
    expect(() => l.download("../a")).toThrow();
  });
});
