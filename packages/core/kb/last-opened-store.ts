"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";
import type { KnowledgeBase } from "../types";

/**
 * The knowledge base last opened in each workspace, kept on this device so the
 * sidebar's knowledge base entry returns to it. Keyed by workspace id, holding
 * the knowledge base id (stable across renames, unlike the slug).
 */
interface KbLastOpenedState {
  byWorkspace: Record<string, string>;
  setLastOpened: (wsId: string, kbId: string) => void;
}

export const useKbLastOpenedStore = create<KbLastOpenedState>()(
  persist(
    (set) => ({
      byWorkspace: {},
      setLastOpened: (wsId, kbId) =>
        set((state) => {
          if (!wsId || !kbId || state.byWorkspace[wsId] === kbId) return state;

          return { byWorkspace: { ...state.byWorkspace, [wsId]: kbId } };
        }),
    }),
    {
      name: "marvis_kb_last_opened",
      storage: createJSONStorage(() => defaultStorage),
    },
  ),
);

/**
 * The knowledge base the entry point opens: the last opened one while it is
 * still listed, otherwise the earliest created. Undefined when there is none.
 */
export function pickEntryKnowledgeBase(
  bases: readonly KnowledgeBase[],
  lastOpenedId: string | undefined,
): KnowledgeBase | undefined {
  const last = lastOpenedId ? bases.find((base) => base.id === lastOpenedId) : undefined;
  if (last) return last;

  let earliest: KnowledgeBase | undefined;
  for (const base of bases) {
    if (!earliest || createdTime(base) < createdTime(earliest)) earliest = base;
  }

  return earliest;
}

// A missing or unparsable timestamp sorts last, so it never wins over a dated base.
function createdTime(base: KnowledgeBase): number {
  const time = Date.parse(base.created_at);

  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}
