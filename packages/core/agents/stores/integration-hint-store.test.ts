// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAgentIntegrationHintStore } from "./integration-hint-store";
import { setCurrentWorkspace } from "../../platform/workspace-storage";

const flush = () => new Promise((resolve) => queueMicrotask(() => resolve(null)));

// Same in-memory Storage shim as view-store.test.ts: Node's jsdom shim lacks
// `clear`/`removeItem`.
beforeAll(() => {
  if (typeof globalThis.localStorage?.clear !== "function") {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (k) => values.get(k) ?? null,
      key: (i) => Array.from(values.keys())[i] ?? null,
      removeItem: (k) => { values.delete(k); },
      setItem: (k, v) => { values.set(k, v); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }
});

beforeEach(() => {
  localStorage.clear();
  useAgentIntegrationHintStore.setState({ pendingAgentIds: [] });
  setCurrentWorkspace(null, null);
});

afterEach(() => {
  setCurrentWorkspace(null, null);
});

describe("useAgentIntegrationHintStore", () => {
  it("keeps a pending id once and drops it for good when seen", () => {
    const { markPending, markSeen } = useAgentIntegrationHintStore.getState();

    markPending("agent_1");
    markPending("agent_1");
    markPending("agent_2");
    expect(useAgentIntegrationHintStore.getState().pendingAgentIds).toEqual([
      "agent_1",
      "agent_2",
    ]);

    markSeen("agent_1");
    markSeen("agent_1");
    expect(useAgentIntegrationHintStore.getState().pendingAgentIds).toEqual([
      "agent_2",
    ]);
  });

  it("persists per workspace and does not leak ids into another workspace", async () => {
    setCurrentWorkspace("acme", "ws_a");
    await flush();
    useAgentIntegrationHintStore.getState().markPending("agent_1");

    const raw = localStorage.getItem("marvis_agent_integration_hint:acme");
    expect(JSON.parse(raw as string).state).toEqual({
      pendingAgentIds: ["agent_1"],
    });

    setCurrentWorkspace("beta", "ws_b");
    await flush();
    await flush();
    expect(useAgentIntegrationHintStore.getState().pendingAgentIds).toEqual([]);

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    expect(useAgentIntegrationHintStore.getState().pendingAgentIds).toEqual([
      "agent_1",
    ]);
  });
});
