"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createWorkspaceAwareStorage,
  registerForWorkspaceRehydration,
} from "../../platform/workspace-storage";
import { defaultStorage } from "../../platform/storage";

// Agents this user created whose Integrations tab they have not opened yet.
// The red dot along the path to that tab reads this set; opening the tab once
// removes the id for good. Only ids are stored — whether the agent is still
// unconnected comes from the installation queries at render time.
export interface AgentIntegrationHintState {
  pendingAgentIds: string[];
  markPending: (agentId: string) => void;
  markSeen: (agentId: string) => void;
}

export const useAgentIntegrationHintStore = create<AgentIntegrationHintState>()(
  persist(
    (set) => ({
      pendingAgentIds: [],
      markPending: (agentId) =>
        set((s) =>
          s.pendingAgentIds.includes(agentId)
            ? s
            : { pendingAgentIds: [...s.pendingAgentIds, agentId] },
        ),
      markSeen: (agentId) =>
        set((s) =>
          s.pendingAgentIds.includes(agentId)
            ? { pendingAgentIds: s.pendingAgentIds.filter((id) => id !== agentId) }
            : s,
        ),
    }),
    {
      name: "marvis_agent_integration_hint",
      storage: createJSONStorage(() =>
        createWorkspaceAwareStorage(defaultStorage),
      ),
      partialize: (state) => ({ pendingAgentIds: state.pendingAgentIds }),
      // A workspace with nothing persisted must not inherit the previous
      // workspace's ids.
      merge: (persisted, current) => ({
        ...current,
        pendingAgentIds:
          (persisted as Partial<AgentIntegrationHintState> | undefined)
            ?.pendingAgentIds ?? [],
      }),
    },
  ),
);

registerForWorkspaceRehydration(() =>
  useAgentIntegrationHintStore.persist.rehydrate(),
);
