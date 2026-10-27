"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgentIntegrationHintStore } from "@marvis/core/agents/stores";
import { larkInstallationsOptions } from "@marvis/core/lark";
import { slackInstallationsOptions } from "@marvis/core/slack";
import { dingtalkInstallationsOptions } from "@marvis/core/dingtalk";
import { wecomInstallationsOptions } from "@marvis/core/wecom";
import { telegramInstallationsOptions } from "@marvis/core/telegram";
import { agentListOptions } from "@marvis/core/workspace/queries";

const ACTIVE_INSTALLATION = "active";

const EMPTY_IDS: ReadonlySet<string> = new Set();

interface InstallationListing {
  configured: boolean;
  installations: { agent_id: string; status: string }[];
}

/**
 * Ids of agents that get a red dot on the path to their Integrations tab:
 * created by this user, tab never opened, still bound to no external channel.
 * Empty while the deployment configures no channel, since the tab is hidden
 * then. Ids of archived or deleted agents are ignored. `workspaceId` is optional
 * because the sidebar also renders outside a workspace.
 */
export function useAgentIntegrationHints(
  workspaceId: string | undefined,
): ReadonlySet<string> {
  const wsId = workspaceId ?? "";
  const pendingAgentIds = useAgentIntegrationHintStore(
    (s) => s.pendingAgentIds,
  );
  const hasPending = pendingAgentIds.length > 0;

  const { data: agents } = useQuery({
    ...agentListOptions(wsId),
    enabled: !!wsId && hasPending,
  });
  const { data: lark } = useQuery({
    ...larkInstallationsOptions(wsId),
    enabled: !!wsId && hasPending,
  });
  const { data: slack } = useQuery({
    ...slackInstallationsOptions(wsId),
    enabled: !!wsId && hasPending,
  });
  const { data: dingtalk } = useQuery({
    ...dingtalkInstallationsOptions(wsId),
    enabled: !!wsId && hasPending,
  });
  const { data: wecom } = useQuery({
    ...wecomInstallationsOptions(wsId),
    enabled: !!wsId && hasPending,
  });
  const { data: telegram } = useQuery({
    ...telegramInstallationsOptions(wsId),
    enabled: !!wsId && hasPending,
  });

  return useMemo(() => {
    if (!hasPending || !agents) return EMPTY_IDS;

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
    const liveAgentIds = new Set(
      agents.filter((agent) => !agent.archived_at).map((agent) => agent.id),
    );

    const ids = pendingAgentIds.filter(
      (id) => liveAgentIds.has(id) && !connected.has(id),
    );

    return ids.length > 0 ? new Set(ids) : EMPTY_IDS;
  }, [
    agents,
    dingtalk,
    hasPending,
    lark,
    pendingAgentIds,
    slack,
    telegram,
    wecom,
  ]);
}
