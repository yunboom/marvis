// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../types";
import { groupRuntimesByMachine, splitRuntimeDeviceInfo } from "./machine-groups";

function runtime(overrides: Partial<AgentRuntime>): AgentRuntime {
  return {
    id: "rt",
    name: "Claude (dev-box)",
    custom_name: null,
    provider: "claude",
    status: "online",
    device_info: "dev-box · 2.1.309",
    daemon_id: "d1",
    ...overrides,
  } as AgentRuntime;
}

describe("splitRuntimeDeviceInfo", () => {
  it.each([
    ["dev-box · 2.1.309 (Claude Code)", "dev-box", "2.1.309 (Claude Code)"],
    ["dev-box", "dev-box", ""],
    ["", "", ""],
    [null, "", ""],
    ["  dev-box  ·  1.0  ", "dev-box", "1.0"],
  ])("splits %j", (input, host, version) => {
    expect(splitRuntimeDeviceInfo(input)).toEqual({ host, version });
  });
});

describe("groupRuntimesByMachine", () => {
  it("groups by daemon in first-seen order and strips the host suffix", () => {
    const groups = groupRuntimesByMachine([
      runtime({ id: "a", name: "Claude (dev-box)" }),
      runtime({ id: "b", name: "Codex (build)", daemon_id: "d2", device_info: "build · 0.149.1", status: "offline" }),
      runtime({ id: "c", name: "Cursor (dev-box)", device_info: "dev-box · 2025.08.09" }),
    ]);

    expect(groups.map((g) => [g.key, g.host, g.online])).toEqual([
      ["d1", "dev-box", true],
      ["d2", "build", false],
    ]);
    expect(groups[0]?.runtimes.map((r) => [r.runtime.id, r.label, r.version])).toEqual([
      ["a", "Claude", "2.1.309"],
      ["c", "Cursor", "2025.08.09"],
    ]);
  });

  it("keeps a custom name as written", () => {
    const [group] = groupRuntimesByMachine([runtime({ custom_name: "My Claude (dev-box)" })]);

    expect(group?.runtimes[0]?.label).toBe("My Claude (dev-box)");
  });

  it("falls back to the host, then the runtime id, when there is no daemon", () => {
    const groups = groupRuntimesByMachine([
      runtime({ id: "a", daemon_id: null }),
      runtime({ id: "b", daemon_id: null, device_info: "" }),
    ]);

    expect(groups.map((g) => g.key)).toEqual(["dev-box", "b"]);
  });
});
