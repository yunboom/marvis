import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const knowledgeKeys = {
  all: (wsId: string) => ["workspaces", wsId, "knowledge"] as const,
  bases: (wsId: string) => ["workspaces", wsId, "knowledge", "bases"] as const,
  deleteImpact: (wsId: string, kbId: string) =>
    ["workspaces", wsId, "knowledge", "bases", kbId, "delete-impact"] as const,
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
