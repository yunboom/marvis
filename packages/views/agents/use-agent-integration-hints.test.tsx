import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAgentIntegrationHintStore } from "@marvis/core/agents/stores";
import { larkInstallationsOptions } from "@marvis/core/lark";
import { slackInstallationsOptions } from "@marvis/core/slack";
import { dingtalkInstallationsOptions } from "@marvis/core/dingtalk";
import { wecomInstallationsOptions } from "@marvis/core/wecom";
import { telegramInstallationsOptions } from "@marvis/core/telegram";
import { runtimeListOptions } from "@marvis/core/runtimes";
import { agentListOptions } from "@marvis/core/workspace/queries";
import { useAgentIntegrationHints } from "./use-agent-integration-hints";

const WS = "ws_1";
const ME = "user_me";

vi.mock("@marvis/core/auth", () => {
  const state = { user: { id: "user_me" } };
  const useAuthStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});

const EMPTY_LISTING = { configured: false, installations: [] };

interface SeedAgent {
  id: string;
  owner_id?: string | null;
  runtime_id?: string;
  archived_at?: string | null;
}

function seed(options: {
  agents: SeedAgent[];
  larkConfigured?: boolean;
  larkInstalls?: { agent_id: string; status: string }[];
  runtimes?: { id: string; provider: string }[];
}) {
  // Fresh-forever data so the hook never reaches the real queryFns.
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const agents = options.agents.map((agent) => ({
    owner_id: ME,
    runtime_id: "rt_claude",
    archived_at: null,
    ...agent,
  }));
  qc.setQueryData(agentListOptions(WS).queryKey, agents as never);
  qc.setQueryData(
    runtimeListOptions(WS).queryKey,
    (options.runtimes ?? [{ id: "rt_claude", provider: "claude" }]) as never,
  );
  qc.setQueryData(larkInstallationsOptions(WS).queryKey, {
    configured: options.larkConfigured ?? true,
    installations: options.larkInstalls ?? [],
  } as never);
  qc.setQueryData(slackInstallationsOptions(WS).queryKey, EMPTY_LISTING as never);
  qc.setQueryData(dingtalkInstallationsOptions(WS).queryKey, EMPTY_LISTING as never);
  qc.setQueryData(wecomInstallationsOptions(WS).queryKey, EMPTY_LISTING as never);
  qc.setQueryData(telegramInstallationsOptions(WS).queryKey, EMPTY_LISTING as never);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  return renderHook(() => useAgentIntegrationHints(WS), { wrapper });
}

beforeEach(() => {
  useAgentIntegrationHintStore.setState({ seenAgentIds: [] });
});

describe("useAgentIntegrationHints", () => {
  it("hints every unconnected agent I own, however it was created", () => {
    const { result } = seed({
      agents: [{ id: "onboarding_marvis" }, { id: "mine" }],
    });

    expect([...result.current]).toEqual(["onboarding_marvis", "mine"]);
  });

  it("does not hint someone else's agent", () => {
    const { result } = seed({ agents: [{ id: "theirs", owner_id: "user_x" }] });

    expect(result.current.size).toBe(0);
  });

  it("does not hint an agent with an active installation", () => {
    const { result } = seed({
      agents: [{ id: "a1" }],
      larkInstalls: [{ agent_id: "a1", status: "active" }],
    });

    expect(result.current.size).toBe(0);
  });

  it("still hints when the only installation was revoked", () => {
    const { result } = seed({
      agents: [{ id: "a1" }],
      larkInstalls: [{ agent_id: "a1", status: "revoked" }],
    });

    expect(result.current.has("a1")).toBe(true);
  });

  it("does not hint when no channel is configured, since the tab is hidden", () => {
    const { result } = seed({ agents: [{ id: "a1" }], larkConfigured: false });

    expect(result.current.size).toBe(0);
  });

  it("skips archived agents and Qoder agents, which have no Integrations tab", () => {
    const { result } = seed({
      agents: [
        { id: "archived", archived_at: "2026-10-01T00:00:00Z" },
        { id: "qoder", runtime_id: "rt_qoder" },
      ],
      runtimes: [{ id: "rt_qoder", provider: "qoder_cloud" }],
    });

    expect(result.current.size).toBe(0);
  });

  it("stops hinting once the integrations tab was opened", () => {
    useAgentIntegrationHintStore.getState().markSeen("a1");

    const { result } = seed({ agents: [{ id: "a1" }] });

    expect(result.current.size).toBe(0);
  });
});
