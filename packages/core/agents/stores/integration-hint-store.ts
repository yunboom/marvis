"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createWorkspaceAwareStorage,
  registerForWorkspaceRehydration,
} from "../../platform/workspace-storage";
import { defaultStorage } from "../../platform/storage";

// Agents whose Integrations tab this user has opened at least once. The red
// dot along the path to that tab shows for every other agent the user owns
// that is still unconnected; opening the tab once adds the id for good. Only
// ids are stored — connection state comes from the installation queries.
export interface AgentIntegrationHintState {
  seenAgentIds: string[];
  markSeen: (agentId: string) => void;
}

export const useAgentIntegrationHintStore = create<AgentIntegrationHintState>()(
  persist(
    (set) => ({
      seenAgentIds: [],
      markSeen: (agentId) =>
        set((s) =>
          s.seenAgentIds.includes(agentId)
            ? s
            : { seenAgentIds: [...s.seenAgentIds, agentId] },
        ),
    }),
    {
      name: "marvis_agent_integration_seen",
      storage: createJSONStorage(() =>
        createWorkspaceAwareStorage(defaultStorage),
      ),
      partialize: (state) => ({ seenAgentIds: state.seenAgentIds }),
      // A workspace with nothing persisted must not inherit the previous
      // workspace's ids.
      merge: (persisted, current) => ({
        ...current,
        seenAgentIds:
          (persisted as Partial<AgentIntegrationHintState> | undefined)
            ?.seenAgentIds ?? [],
      }),
    },
  ),
);

registerForWorkspaceRehydration(() =>
  useAgentIntegrationHintStore.persist.rehydrate(),
);
