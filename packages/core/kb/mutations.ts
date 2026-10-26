import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type {
  CreateKbAnnotationRequest,
  CreateKnowledgeBaseRequest,
  KbAnnotationStatus,
  UpdateKnowledgeBaseRequest,
} from "../types/kb";
import { kbKeys } from "./queries";
import { invalidateKbAnnotations } from "./ws-updaters";

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

/** Records an annotation; awaits the server (the anchor is checked there). */
export function useCreateKbAnnotation() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ kb, data }: { kb: string; data: CreateKbAnnotationRequest }) =>
      api.createKnowledgeBaseAnnotation(kb, data),
    onSettled: () => invalidateKbAnnotations(qc, wsId),
  });
}

/** Dismisses an annotation or reopens a dismissed one. */
export function useUpdateKbAnnotationStatus() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Extract<KbAnnotationStatus, "pending" | "dismissed"> }) =>
      api.updateKnowledgeBaseAnnotation(id, { status }),
    onSettled: () => invalidateKbAnnotations(qc, wsId),
  });
}
