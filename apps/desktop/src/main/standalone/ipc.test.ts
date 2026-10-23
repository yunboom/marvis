// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  STANDALONE_INSTALL,
  STANDALONE_SWITCH_REMOTE,
  VALIDATION_REQUIRED,
  defaultStandaloneSettings,
  generateStandaloneSecrets,
} from "../../shared/standalone";
import { registerStandaloneIpc, toSetupInput } from "./ipc";
import type { IpcMainLike } from "../server-ipc";
import { StandaloneValidationError, type StandaloneManager } from "./manager";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    ipcMain: ({
      on: (channel: string, listener: Handler) => handlers.set(channel, listener),
      handle: (channel: string, listener: Handler) => handlers.set(channel, listener),
    } as unknown as IpcMainLike),
  };
}

function validInput() {
  const settings = defaultStandaloneSettings("studio");
  settings.adminEmail = "admin@example.com";
  return { settings, secrets: generateStandaloneSecrets() };
}

describe("toSetupInput", () => {
  it("accepts a well-formed payload", () => {
    const input = validInput();
    expect(toSetupInput(input)).toEqual(input);
  });

  it.each([
    ["null", null],
    ["missing secrets", { settings: validInput().settings }],
    ["port as string", { ...validInput(), settings: { ...validInput().settings, port: "13840" } }],
    [
      "missing integration key",
      { ...validInput(), secrets: { ...validInput().secrets, integrationKeys: { MARVIS_LARK_SECRET_KEY: "x" } } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(toSetupInput(value)).toBeNull();
  });
});

describe("registerStandaloneIpc", () => {
  it("returns validation errors from install instead of throwing", async () => {
    const { handlers, ipcMain } = fakeIpc();
    const manager = {
      install: vi.fn(async () => {
        throw new StandaloneValidationError({ "settings.adminEmail": VALIDATION_REQUIRED });
      }),
    } as unknown as StandaloneManager;
    registerStandaloneIpc({ ipcMain, manager, broadcast: vi.fn(), openPath: vi.fn(), selectRemote: vi.fn() });

    await expect(handlers.get(STANDALONE_INSTALL)!({}, validInput())).resolves.toEqual({
      ok: false,
      errors: { "settings.adminEmail": VALIDATION_REQUIRED },
    });
  });

  it("switches to the remote server before stopping standalone mode", async () => {
    const { handlers, ipcMain } = fakeIpc();
    const order: string[] = [];
    const manager = { stopForRemote: vi.fn(async () => order.push("stop")) } as unknown as StandaloneManager;
    const selectRemote = vi.fn(async () => {
      order.push("select");
    });
    registerStandaloneIpc({ ipcMain, manager, broadcast: vi.fn(), openPath: vi.fn(), selectRemote });

    await handlers.get(STANDALONE_SWITCH_REMOTE)!({}, {
      url: "http://192.168.1.37:13840",
      name: "marvis-dev",
      instanceId: "abc",
      source: "manual",
      appUrl: "",
    });

    expect(order).toEqual(["select", "stop"]);
  });

  it("rejects a malformed remote selection without stopping", async () => {
    const { handlers, ipcMain } = fakeIpc();
    const manager = { stopForRemote: vi.fn() } as unknown as StandaloneManager;
    registerStandaloneIpc({ ipcMain, manager, broadcast: vi.fn(), openPath: vi.fn(), selectRemote: vi.fn() });

    await expect(handlers.get(STANDALONE_SWITCH_REMOTE)!({}, { url: "nope" })).rejects.toThrow();
    expect(manager.stopForRemote).not.toHaveBeenCalled();
  });
});
