import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type { CreateKnowledgeBaseRequest, UpdateKnowledgeBaseRequest } from "../types/kb";
import { kbKeys } from "./queries";

/** Creates a knowledge base; the list and its counters refetch afterwards. */
export function useCreateKnowledgeBase() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (data: CreateKnowledgeBaseRequest) => api.createKnowledgeBase(data),
    onSettled: () => qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) }),
  });
}

/**
 * Saves a knowledge base's configuration. Not optimistic: a save can be
 * refused as stale (409), and the editor must keep its text when it is.
 */
export function useUpdateKnowledgeBase() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ kb, data }: { kb: string; data: UpdateKnowledgeBaseRequest }) =>
      api.updateKnowledgeBase(kb, data),
    onSettled: (_result, _error, { kb }) => {
      void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
      void qc.invalidateQueries({ queryKey: kbKeys.home(wsId, kb) });
    },
  });
}
