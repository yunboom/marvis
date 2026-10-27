"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgentIntegrationHintStore } from "@marvis/core/agents/stores";
import { useAuthStore } from "@marvis/core/auth";
import { larkInstallationsOptions } from "@marvis/core/lark";
import { slackInstallationsOptions } from "@marvis/core/slack";
import { dingtalkInstallationsOptions } from "@marvis/core/dingtalk";
import { wecomInstallationsOptions } from "@marvis/core/wecom";
import { telegramInstallationsOptions } from "@marvis/core/telegram";
import { runtimeListOptions } from "@marvis/core/runtimes";
import { agentListOptions } from "@marvis/core/workspace/queries";
import { QODER_PROVIDER } from "./create/runtime-choice";

const ACTIVE_INSTALLATION = "active";

const EMPTY_IDS: ReadonlySet<string> = new Set();

interface InstallationListing {
  configured: boolean;
  installations: { agent_id: string; status: string }[];
}

/**
 * Ids of agents that get a red dot on the path to their Integrations tab:
 * owned by this user, tab never opened, still bound to no external channel.
 * Covers every creation path (create flow, onboarding, CLI). Empty while the
 * deployment configures no channel, since the tab is hidden then; archived
 * and Qoder agents are skipped for the same reason. `workspaceId` is optional
 * because the sidebar also renders outside a workspace.
 */
export function useAgentIntegrationHints(
  workspaceId: string | undefined,
): ReadonlySet<string> {
  const wsId = workspaceId ?? "";
  const enabled = !!wsId;
  const userId = useAuthStore((s) => s.user?.id);
  const seenAgentIds = useAgentIntegrationHintStore((s) => s.seenAgentIds);

  const { data: agents } = useQuery({ ...agentListOptions(wsId), enabled });
  const { data: runtimes } = useQuery({
    ...runtimeListOptions(wsId),
    enabled,
  });
  const { data: lark } = useQuery({
    ...larkInstallationsOptions(wsId),
    enabled,
  });
  const { data: slack } = useQuery({
    ...slackInstallationsOptions(wsId),
    enabled,
  });
  const { data: dingtalk } = useQuery({
    ...dingtalkInstallationsOptions(wsId),
    enabled,
  });
  const { data: wecom } = useQuery({
    ...wecomInstallationsOptions(wsId),
    enabled,
  });
  const { data: telegram } = useQuery({
    ...telegramInstallationsOptions(wsId),
    enabled,
  });

  return useMemo(() => {
    if (!userId || !agents) return EMPTY_IDS;

    const listings: (InstallationListing | undefined)[] = [
      lark,
      slack,
      dingtalk,
      wecom,
      telegram,
    ];
    if (!listings.some((listing) => listing?.configured === true)) {
      return EMPTY_IDS;
    }

    const connected = new Set<string>();
    for (const listing of listings) {
      for (const inst of listing?.installations ?? []) {
        if (inst.status === ACTIVE_INSTALLATION) connected.add(inst.agent_id);
      }
    }
    const qoderRuntimeIds = new Set(
      (runtimes ?? [])
        .filter((runtime) => runtime.provider === QODER_PROVIDER)
        .map((runtime) => runtime.id),
    );
    const seen = new Set(seenAgentIds);

    const ids = agents
      .filter(
        (agent) =>
          agent.owner_id === userId &&
          !agent.archived_at &&
          !qoderRuntimeIds.has(agent.runtime_id) &&
          !connected.has(agent.id) &&
          !seen.has(agent.id),
      )
      .map((agent) => agent.id);

    return ids.length > 0 ? new Set(ids) : EMPTY_IDS;
  }, [
    agents,
    dingtalk,
    lark,
    runtimes,
    seenAgentIds,
    slack,
    telegram,
    userId,
    wecom,
  ]);
}
