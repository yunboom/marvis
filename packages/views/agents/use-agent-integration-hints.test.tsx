import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAgentIntegrationHintStore } from "@marvis/core/agents/stores";
import { larkInstallationsOptions } from "@marvis/core/lark";
import { slackInstallationsOptions } from "@marvis/core/slack";
import { dingtalkInstallationsOptions } from "@marvis/core/dingtalk";
import { wecomInstallationsOptions } from "@marvis/core/wecom";
import { telegramInstallationsOptions } from "@marvis/core/telegram";
import { agentListOptions } from "@marvis/core/workspace/queries";
import { useAgentIntegrationHints } from "./use-agent-integration-hints";

const WS = "ws_1";

const EMPTY_LISTING = { configured: false, installations: [] };

function seed(options: {
  larkConfigured?: boolean;
  larkInstalls?: { agent_id: string; status: string }[];
  agents?: { id: string; archived_at: string | null }[];
}) {
  // Fresh-forever data so the hook never reaches the real queryFns.
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(agentListOptions(WS).queryKey, (options.agents ?? []) as never);
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

const live = (id: string) => ({ id, archived_at: null });

beforeEach(() => {
  useAgentIntegrationHintStore.setState({ pendingAgentIds: [] });
});

describe("useAgentIntegrationHints", () => {
  it("hints a newly created agent that has no integration", () => {
    useAgentIntegrationHintStore.getState().markPending("a1");

    const { result } = seed({ agents: [live("a1"), live("a2")] });

    expect([...result.current]).toEqual(["a1"]);
  });

  it("does not hint an agent with an active installation", () => {
    useAgentIntegrationHintStore.getState().markPending("a1");

    const { result } = seed({
      agents: [live("a1")],
      larkInstalls: [{ agent_id: "a1", status: "active" }],
    });

    expect(result.current.size).toBe(0);
  });

  it("still hints when the only installation was revoked", () => {
    useAgentIntegrationHintStore.getState().markPending("a1");

    const { result } = seed({
      agents: [live("a1")],
      larkInstalls: [{ agent_id: "a1", status: "revoked" }],
    });

    expect(result.current.has("a1")).toBe(true);
  });

  it("does not hint when no channel is configured, since the tab is hidden", () => {
    useAgentIntegrationHintStore.getState().markPending("a1");

    const { result } = seed({ agents: [live("a1")], larkConfigured: false });

    expect(result.current.size).toBe(0);
  });

  it("ignores archived and deleted agents", () => {
    useAgentIntegrationHintStore.getState().markPending("archived");
    useAgentIntegrationHintStore.getState().markPending("deleted");

    const { result } = seed({
      agents: [{ id: "archived", archived_at: "2026-10-01T00:00:00Z" }],
    });

    expect(result.current.size).toBe(0);
  });

  it("stops hinting once the integrations tab was opened", () => {
    useAgentIntegrationHintStore.getState().markPending("a1");
    useAgentIntegrationHintStore.getState().markSeen("a1");

    const { result } = seed({ agents: [live("a1")] });

    expect(result.current.size).toBe(0);
  });
});
