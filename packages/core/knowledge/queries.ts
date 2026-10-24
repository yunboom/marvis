import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { KnowledgeGapStatus } from "./schemas";

// Everything lives under knowledgeKeys.all so one `knowledge:changed` event
// invalidates the whole knowledge surface of the workspace.
export const knowledgeKeys = {
  all: (wsId: string) => ["workspaces", wsId, "knowledge"] as const,
  bases: (wsId: string) => ["workspaces", wsId, "knowledge", "bases"] as const,
  deleteImpact: (wsId: string, kbId: string) =>
    ["workspaces", wsId, "knowledge", "bases", kbId, "delete-impact"] as const,
  pages: (wsId: string, kbId: string) => ["workspaces", wsId, "knowledge", "pages", kbId] as const,
  page: (wsId: string, kbId: string, path: string) => ["workspaces", wsId, "knowledge", "page", kbId, path] as const,
  graph: (wsId: string, kbId: string) => ["workspaces", wsId, "knowledge", "graph", kbId] as const,
  search: (wsId: string, query: string) => ["workspaces", wsId, "knowledge", "search", query] as const,
  gaps: (wsId: string, status: KnowledgeGapStatus | "all") => ["workspaces", wsId, "knowledge", "gaps", status] as const,
};

export function knowledgeBaseListOptions(wsId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.bases(wsId),
    queryFn: () => api.listKnowledgeBases(),
  });
}

export function knowledgeDeleteImpactOptions(wsId: string, kbId: string, enabled: boolean) {
  return queryOptions({
    queryKey: knowledgeKeys.deleteImpact(wsId, kbId),
    queryFn: () => api.getKnowledgeDeleteImpact(kbId),
    enabled: enabled && !!kbId,
  });
}

export function knowledgePageListOptions(wsId: string, kbId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.pages(wsId, kbId),
    queryFn: () => api.listKnowledgePages(kbId),
    enabled: !!kbId,
  });
}

export function knowledgePageOptions(wsId: string, kbId: string, path: string | null) {
  return queryOptions({
    queryKey: knowledgeKeys.page(wsId, kbId, path ?? ""),
    queryFn: () => api.getKnowledgePage(kbId, path ?? ""),
    enabled: !!kbId && !!path,
  });
}

export function knowledgeGraphOptions(wsId: string, kbId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.graph(wsId, kbId),
    queryFn: () => api.getKnowledgeGraph(kbId),
    enabled: !!kbId,
  });
}

export function knowledgeSearchOptions(wsId: string, query: string) {
  return queryOptions({
    queryKey: knowledgeKeys.search(wsId, query),
    queryFn: () => api.searchKnowledge(query),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
  });
}

export function knowledgeGapListOptions(wsId: string, status: KnowledgeGapStatus | "all") {
  return queryOptions({
    queryKey: knowledgeKeys.gaps(wsId, status),
    queryFn: () => api.listKnowledgeGaps(status === "all" ? undefined : status),
  });
}
