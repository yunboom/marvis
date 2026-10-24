"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import { issueKeys } from "@marvis/core/issues/queries";
import { parseMentions } from "@marvis/core/issues/comment-trigger-outcomes";
import type { CommentTriggerPreviewAgent, CommentTriggerOutcome } from "@marvis/core/types";

const COMMENT_TRIGGER_PREVIEW_DEBOUNCE_MS = 300;
const NOTE_COMMAND_RE = /^\/note(?:$|\s)/i;

export interface UseCommentTriggerPreviewResult {
  agents: CommentTriggerPreviewAgent[];
  // Explicit @agent / @squad mentions that will NOT trigger if posted as-is
  // (MUL-4525 §2), so the composer can warn before sending.
  blocked: CommentTriggerOutcome[];
  // A structured @all mention is a member broadcast, but never starts agents
  // by itself. This is static mention semantics, not a delivery guarantee:
  // edits do not notify, and a new comment may have no eligible recipients.
  hasAllMembersMention: boolean;
  /**
   * Whether `agents` answers the draft's current mentions. While a changed
   * @mention is still debouncing or loading, the previous answer is shown;
   * nothing destructive may act on it.
   */
  isCurrent: boolean;
}

export function isNoteCommentDraft(content: string): boolean {
  return NOTE_COMMAND_RE.test(content.replace(/^[ \t\r\n]+/, ""));
}

export function commentTriggerPreviewSignature(content: string): string {
  if (!content.trim() || isNoteCommentDraft(content)) return "empty";

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const { type, id } of parseMentions(content)) {
    if (type === "issue") continue;
    const token = `${type}:${id}`;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return `nonempty|${tokens.join(",")}`;
}

function queryKeyMatchesPreviewContext(
  queryKey: readonly unknown[] | undefined,
  issueId: string,
  parentId: string,
  editingCommentId: string,
) {
  if (!queryKey) return false;
  const prefix = issueKeys.commentTriggerPreview(issueId);
  return (
    prefix.every((part, index) => queryKey[index] === part) &&
    queryKey[prefix.length] === parentId &&
    queryKey[prefix.length + 1] === editingCommentId
  );
}

// Text with no mentions: every such draft gets the same answer, so it needs
// neither a debounce nor the draft itself — the probe stands in for it.
const PLAIN_SIGNATURE = "nonempty|";
const PLAIN_PREVIEW_PROBE = ".";

function useDebouncedSignature(signature: string) {
  const [debouncedSignature, setDebouncedSignature] = useState("empty");

  useEffect(() => {
    if (signature === "empty" || signature === PLAIN_SIGNATURE) {
      setDebouncedSignature(signature);
      return;
    }

    const timer = window.setTimeout(() => {
      setDebouncedSignature(signature);
    }, COMMENT_TRIGGER_PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [signature]);

  return debouncedSignature;
}

export function useCommentTriggerPreview({
  issueId,
  parentId,
  editingCommentId,
  content,
  prefetch = false,
}: {
  issueId: string;
  parentId?: string;
  editingCommentId?: string;
  content: string;
  /** Fetch the no-mention answer while the draft is still empty, so the
   *  recipient chips are ready on the first keystroke. */
  prefetch?: boolean;
}): UseCommentTriggerPreviewResult {
  const signature = useMemo(() => commentTriggerPreviewSignature(content), [content]);
  const hasAllMembersMention = useMemo(
    () => parseMentions(content).some(({ type, id }) => type === "all" && id === "all"),
    [content],
  );
  const debouncedSignature = useDebouncedSignature(signature);
  // Plain text skips the debounce render; an empty draft being prefetched
  // queries the plain answer it will show on the first keystroke.
  const settledSignature = signature === PLAIN_SIGNATURE ? PLAIN_SIGNATURE : debouncedSignature;
  const querySignature = settledSignature === "empty" && prefetch ? PLAIN_SIGNATURE : settledSignature;
  const contentRef = useRef(content);
  const parentKey = parentId ?? "";
  const editingKey = editingCommentId ?? "";

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const previewQuery = useQuery({
    queryKey: [...issueKeys.commentTriggerPreview(issueId), parentKey, editingKey, querySignature],
    queryFn: () => {
      const draft = contentRef.current;
      const body = commentTriggerPreviewSignature(draft) === "empty" ? PLAIN_PREVIEW_PROBE : draft;
      return api.previewCommentTriggers(issueId, body, parentId, editingCommentId);
    },
    enabled: querySignature !== "empty",
    retry: false,
    // The answer depends on live queue state (pending-task dedup), not just
    // the mention set, so a cached result must revalidate when its signature
    // reappears — Infinity here once pinned a stale "nobody triggers"
    // snapshot taken while the agent was still queued.
    staleTime: 0,
    // Keep the previous agent list only while the same composer context is
    // re-fetching. Crossing issue/parent/edit context must not display stale
    // chips from another composer.
    placeholderData: (previousData, previousQuery) =>
      queryKeyMatchesPreviewContext(previousQuery?.queryKey, issueId, parentKey, editingKey)
        ? keepPreviousData(previousData)
        : undefined,
  });

  // The prefetched answer shows at once on the first keystroke; revalidate it
  // then, since run state may have moved while the draft sat empty.
  const { refetch } = previewQuery;
  const previousSignatureRef = useRef(signature);
  useEffect(() => {
    const previous = previousSignatureRef.current;
    previousSignatureRef.current = signature;
    if (prefetch && previous === "empty" && signature === PLAIN_SIGNATURE) void refetch();
  }, [prefetch, refetch, signature]);

  // Loading and errors intentionally surface as "no agents": the preview is
  // an enhancement, and the composer renders nothing for an empty list.
  if (signature === "empty" || settledSignature === "empty") {
    return { agents: [], blocked: [], hasAllMembersMention, isCurrent: signature === "empty" };
  }

  return {
    agents: previewQuery.data?.agents ?? [],
    blocked: previewQuery.data?.blocked ?? [],
    hasAllMembersMention,
    isCurrent: signature === settledSignature && previewQuery.isSuccess && !previewQuery.isPlaceholderData,
  };
}
