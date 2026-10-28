"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";
import { isRuntimeUsableForUser } from "../runtimes/access";
import type { RuntimeDevice } from "../types";

/**
 * The runtime each member last started a knowledge base builder on, kept on
 * this device per workspace so the builder page opens on it again.
 */
interface KbBuilderRuntimeState {
  byKey: Record<string, string>;
  setLastRuntime: (wsId: string, userId: string, runtimeId: string) => void;
}

/** Storage key of one member's choice in one workspace. */
export function kbBuilderRuntimeKey(wsId: string, userId: string): string {
  return `${wsId}:${userId}`;
}

export const useKbBuilderRuntimeStore = create<KbBuilderRuntimeState>()(
  persist(
    (set) => ({
      byKey: {},
      setLastRuntime: (wsId, userId, runtimeId) =>
        set((state) => {
          const key = kbBuilderRuntimeKey(wsId, userId);
          if (!wsId || !userId || !runtimeId || state.byKey[key] === runtimeId) return state;

          return { byKey: { ...state.byKey, [key]: runtimeId } };
        }),
    }),
    {
      name: "marvis_kb_builder_runtime",
      storage: createJSONStorage(() => defaultStorage),
    },
  ),
);

/** Whether the builder can start on `runtime` for this member right now. */
export function isKbBuilderRuntimeReady(runtime: RuntimeDevice, currentUserId: string | null): boolean {
  return runtime.status === "online" && isRuntimeUsableForUser(runtime, currentUserId);
}

/** The runtime the builder page selects before the member picks one. */
export interface KbBuilderDefaultRuntime {
  runtime: RuntimeDevice;
  /** Whether it can run the builder right now. */
  online: boolean;
}

/**
 * The builder page's initial runtime, decided in one place so a late runtime
 * list can never race a second picker into a different choice:
 *
 * 1. the last used one while it is online and usable;
 * 2. else the first online usable one, the member's own runtimes first;
 * 3. else, nothing being online, the last used one (or the first usable one),
 *    shown offline so the page can say so.
 *
 * Null when the member may use no runtime at all.
 */
export function pickKbBuilderRuntime(
  runtimes: readonly RuntimeDevice[],
  currentUserId: string | null,
  lastRuntimeId: string | undefined,
): KbBuilderDefaultRuntime | null {
  const usable = runtimes
    .filter((runtime) => isRuntimeUsableForUser(runtime, currentUserId))
    .toSorted((a, b) => Number(b.owner_id === currentUserId) - Number(a.owner_id === currentUserId));
  const last = lastRuntimeId ? usable.find((runtime) => runtime.id === lastRuntimeId) : undefined;

  if (last?.status === "online") return { runtime: last, online: true };

  const firstOnline = usable.find((runtime) => runtime.status === "online");
  if (firstOnline) return { runtime: firstOnline, online: true };

  const fallback = last ?? usable[0];

  return fallback ? { runtime: fallback, online: false } : null;
}
