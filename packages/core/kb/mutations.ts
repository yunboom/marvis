import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type {
  CreateKbAnnotationRequest,
  CreateKbJobRequest,
  CreateKbMrCommentRequest,
  CreateKnowledgeBaseRequest,
  KbAnnotationStatus,
  KbRawKind,
  UpdateKnowledgeBaseRequest,
} from "../types/kb";
import { kbKeys } from "./queries";
import {
  invalidateKbAnnotations,
  invalidateKbJobs,
  invalidateKbMainline,
  invalidateKbMergeRequests,
  invalidateKbMrComments,
} from "./ws-updaters";

/**
 * Starts a job. Awaits the server: the job page needs the job and its chat
 * session, which only exist once the first message is sent.
 */
export function useCreateKbJob() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ kb, data }: { kb: string; data: CreateKbJobRequest }) => api.createKnowledgeBaseJob(kb, data),
    onSettled: (_job, _error, { kb }) => qc.invalidateQueries({ queryKey: kbKeys.jobs(wsId, kb) }),
  });
}

/** Submits a job's draft for review; the job turns read-only. */
export function useSubmitKbJob() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (jobId: string) => api.submitKnowledgeBaseJob(jobId),
    onSettled: () => {
      invalidateKbMergeRequests(qc, wsId);
      invalidateKbAnnotations(qc, wsId);
    },
  });
}

/** Discards a job's draft; the job stays listed. */
export function useDiscardKbJob() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (jobId: string) => api.discardKnowledgeBaseJob(jobId),
    onSettled: () => invalidateKbJobs(qc, wsId),
  });
}

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

/**
 * Merges a merge request with the draft version the reviewer saw. Awaits the
 * server: a newer draft or a conflict is refused (409) and nothing changes.
 */
export function useMergeKbMergeRequest() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, draftVersion }: { number: number; draftVersion: number }) =>
      api.mergeKnowledgeBaseMergeRequest(number, draftVersion),
    onSettled: () => invalidateKbMainline(qc, wsId),
  });
}

/** Closes a merge request; its annotations go back to pending. */
export function useCloseKbMergeRequest() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, reason }: { number: number; reason?: string }) =>
      api.closeKnowledgeBaseMergeRequest(number, reason),
    onSettled: () => invalidateKbMainline(qc, wsId),
  });
}

/** Opens a merge request that undoes a merged one. */
export function useRevertKbMergeRequest() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (number: number) => api.revertKnowledgeBaseMergeRequest(number),
    onSettled: () => invalidateKbMergeRequests(qc, wsId),
  });
}

/** Posts a review comment; the agents it starts show on the comment. */
export function useCreateKbMrComment() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, data }: { number: number; data: CreateKbMrCommentRequest }) =>
      api.createKnowledgeBaseMrComment(number, data),
    onSettled: (_comment, _error, { number }) => invalidateKbMrComments(qc, wsId, number),
  });
}

/**
 * Uploads raw files to a knowledge base. Awaits the server: a name already
 * taken is refused (409) and nothing is written.
 */
export function useUploadKbRawFiles() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ kb, files, kind }: { kb: string; files: readonly File[]; kind?: KbRawKind }) =>
      api.uploadKnowledgeBaseRawFiles(kb, files, kind),
    onSettled: (_files, _error, { kb }) => {
      void qc.invalidateQueries({ queryKey: kbKeys.raws(wsId, kb) });
      // Citations of a file that now exists become openable.
      void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
    },
  });
}

/**
 * Deletes a knowledge base. Awaits the server; the caller leaves the
 * knowledge base's pages once it answers.
 */
export function useDeleteKnowledgeBase() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ kb, confirmName }: { kb: string; confirmName: string }) => api.deleteKnowledgeBase(kb, confirmName),
    onSettled: () => qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) }),
  });
}
