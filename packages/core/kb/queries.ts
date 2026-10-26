import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { KnowledgeBase, KnowledgeBaseDetail } from "../types/kb";

export const kbKeys = {
  all: (wsId: string) => ["kb", wsId] as const,
  bases: (wsId: string) => [...kbKeys.all(wsId), "bases"] as const,
  /** `kb` is the id or slug the caller addressed the knowledge base by. */
  base: (wsId: string, kb: string) => [...kbKeys.bases(wsId), kb] as const,
};

export function kbBaseListOptions(wsId: string) {
  return queryOptions<KnowledgeBase[]>({
    queryKey: kbKeys.bases(wsId),
    queryFn: () => api.listKnowledgeBases(),
    enabled: !!wsId,
  });
}

export function kbBaseDetailOptions(wsId: string, kb: string) {
  return queryOptions<KnowledgeBaseDetail>({
    queryKey: kbKeys.base(wsId, kb),
    queryFn: () => api.getKnowledgeBase(kb),
    enabled: !!wsId && !!kb,
  });
}

/** Merge requests waiting for review across the given knowledge bases. */
export function countOpenMergeRequests(bases: readonly KnowledgeBase[]): number {
  let total = 0;
  for (const base of bases) total += base.pending.open_mrs;
  return total;
}
