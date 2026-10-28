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

/**
 * Archives or unarchives a job. Awaits the server, as discarding does: the
 * row moves between the list's two views once the refetch lands.
 */
export function useSetKbJobArchived() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ jobId, archived }: { jobId: string; archived: boolean }) =>
      api.setKnowledgeBaseJobArchived(jobId, archived),
    onSettled: () => invalidateKbJobs(qc, wsId),
  });
}

/**
 * Hard-deletes a job and its chat. Not optimistic: callers await it before
 * leaving the job. A merge request made from the job loses its origin link,
 * so the review lists refetch too.
 */
export function useDeleteKbJob() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (jobId: string) => api.deleteKnowledgeBaseJob(jobId),
    // The job is gone; dropping its detail keeps an open job page from
    // refetching into a not-found state before it navigates away.
    onSuccess: (_, jobId) => qc.removeQueries({ queryKey: kbKeys.job(wsId, jobId) }),
    onSettled: () => invalidateKbMergeRequests(qc, wsId),
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

/** Posts a comment: into the viewer's review with review_id, else the owner's reply. */
export function useCreateKbMrComment() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, data }: { number: number; data: CreateKbMrCommentRequest }) =>
      api.createKnowledgeBaseMrComment(number, data),
    onSettled: (_comment, _error, { number }) => invalidateKbMrComments(qc, wsId, number),
  });
}

/** Starts the viewer's review, or returns the one already pending. */
export function useOpenKbMrReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (number: number) => api.openKnowledgeBaseMrReview(number),
    onSettled: (_review, _error, number) => invalidateKbMrComments(qc, wsId, number),
  });
}

/** Edits one of the viewer's pending comments. */
export function useUpdateKbMrComment() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, commentId, body }: { number: number; commentId: string; body: string }) =>
      api.updateKnowledgeBaseMrComment(number, commentId, body),
    onSettled: (_comment, _error, { number }) => invalidateKbMrComments(qc, wsId, number),
  });
}

/** Removes one of the viewer's pending comments. */
export function useDeleteKbMrComment() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, commentId }: { number: number; commentId: string }) =>
      api.deleteKnowledgeBaseMrComment(number, commentId),
    onSettled: (_result, _error, { number }) => invalidateKbMrComments(qc, wsId, number),
  });
}

/** Publishes the viewer's review; the merge request becomes changes_requested. */
export function useSubmitKbMrReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, reviewId, summary }: { number: number; reviewId: string; summary?: string }) =>
      api.submitKnowledgeBaseMrReview(number, reviewId, summary),
    onSettled: () => invalidateKbMergeRequests(qc, wsId),
  });
}

/** Drops the viewer's pending review and its comments. */
export function useDiscardKbMrReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, reviewId }: { number: number; reviewId: string }) =>
      api.discardKnowledgeBaseMrReview(number, reviewId),
    onSettled: (_result, _error, { number }) => invalidateKbMrComments(qc, wsId, number),
  });
}

/** The owner asks for review again. */
export function useRequestKbMrReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (number: number) => api.requestKnowledgeBaseMrReview(number),
    onSettled: () => invalidateKbMergeRequests(qc, wsId),
  });
}

/** Hands the open review feedback to the job's agent with a visible `message`. */
export function useHandoffKbMrReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: ({ number, message }: { number: number; message: string }) =>
      api.handoffKnowledgeBaseMrReview(number, message),
    onSettled: () => invalidateKbJobs(qc, wsId),
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
