// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeDevice } from "../types";
import {
  isKbBuilderRuntimeReady,
  kbBuilderRuntimeKey,
  pickKbBuilderRuntime,
  useKbBuilderRuntimeStore,
} from "./builder-runtime";

function runtime(id: string, overrides: Partial<RuntimeDevice> = {}): RuntimeDevice {
  return {
    id,
    workspace_id: "ws-1",
    daemon_id: null,
    name: id,
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "host",
    metadata: {},
    owner_id: "me",
    visibility: "private",
    last_seen_at: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  } as RuntimeDevice;
}

const MINE_ONLINE = runtime("mine-online");
const MINE_ONLINE_2 = runtime("mine-online-2");
const MINE_OFFLINE = runtime("mine-offline", { status: "offline" });
const PUBLIC_ONLINE = runtime("public-online", { owner_id: "other", visibility: "public" });
const LOCKED_ONLINE = runtime("locked-online", { owner_id: "other", visibility: "private" });

describe("pickKbBuilderRuntime", () => {
  it("keeps the last used runtime while it is online and usable", () => {
    expect(pickKbBuilderRuntime([MINE_ONLINE, MINE_ONLINE_2], "me", "mine-online-2")).toEqual({
      runtime: MINE_ONLINE_2,
      online: true,
    });
  });

  it("falls back to the first online usable runtime, own ones first, when the last one is offline", () => {
    expect(pickKbBuilderRuntime([PUBLIC_ONLINE, MINE_OFFLINE, MINE_ONLINE], "me", "mine-offline")).toEqual({
      runtime: MINE_ONLINE,
      online: true,
    });
  });

  it("never auto-picks an offline runtime while a usable one is online", () => {
    expect(pickKbBuilderRuntime([MINE_OFFLINE, PUBLIC_ONLINE], "me", undefined)).toEqual({
      runtime: PUBLIC_ONLINE,
      online: true,
    });
  });

  it("ignores a last used runtime that is no longer usable or listed", () => {
    expect(pickKbBuilderRuntime([LOCKED_ONLINE, PUBLIC_ONLINE], "me", "locked-online")).toEqual({
      runtime: PUBLIC_ONLINE,
      online: true,
    });
    expect(pickKbBuilderRuntime([MINE_ONLINE], "me", "deleted")?.runtime).toBe(MINE_ONLINE);
  });

  it("shows the last used runtime offline when nothing is online", () => {
    const other = runtime("other-offline", { status: "offline" });

    expect(pickKbBuilderRuntime([other, MINE_OFFLINE], "me", "mine-offline")).toEqual({
      runtime: MINE_OFFLINE,
      online: false,
    });
  });

  it("shows the first usable runtime offline when nothing is online and none was used", () => {
    const locked = runtime("locked", { owner_id: "other", status: "offline" });

    expect(pickKbBuilderRuntime([locked, MINE_OFFLINE], "me", undefined)).toEqual({
      runtime: MINE_OFFLINE,
      online: false,
    });
  });

  it("never picks a runtime the member may not use", () => {
    expect(pickKbBuilderRuntime([LOCKED_ONLINE], "me", undefined)).toBeNull();
  });

  it("returns nothing without runtimes", () => {
    expect(pickKbBuilderRuntime([], "me", "mine-online")).toBeNull();
  });
});

describe("isKbBuilderRuntimeReady", () => {
  it("requires the runtime to be online and usable", () => {
    expect(isKbBuilderRuntimeReady(MINE_ONLINE, "me")).toBe(true);
    expect(isKbBuilderRuntimeReady(MINE_OFFLINE, "me")).toBe(false);
    expect(isKbBuilderRuntimeReady(LOCKED_ONLINE, "me")).toBe(false);
  });
});

describe("useKbBuilderRuntimeStore", () => {
  afterEach(() => useKbBuilderRuntimeStore.setState({ byKey: {} }));

  it("remembers the choice per workspace and member", () => {
    const { setLastRuntime } = useKbBuilderRuntimeStore.getState();
    setLastRuntime("ws-1", "me", "rt-a");
    setLastRuntime("ws-2", "me", "rt-b");

    const { byKey } = useKbBuilderRuntimeStore.getState();
    expect(byKey[kbBuilderRuntimeKey("ws-1", "me")]).toBe("rt-a");
    expect(byKey[kbBuilderRuntimeKey("ws-2", "me")]).toBe("rt-b");
    expect(byKey[kbBuilderRuntimeKey("ws-1", "other")]).toBeUndefined();
  });

  it("ignores an empty runtime", () => {
    useKbBuilderRuntimeStore.getState().setLastRuntime("ws-1", "me", "");

    expect(useKbBuilderRuntimeStore.getState().byKey).toEqual({});
  });
});
