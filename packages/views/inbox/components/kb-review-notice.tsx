"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@marvis/core/auth";
import { kbMergeRequestOptions, kbMrCommentListOptions } from "@marvis/core/kb/queries";
import { paths, useWorkspaceSlug } from "@marvis/core/paths";
import type { InboxItem, KbMergeRequestDetail, KbMrReview } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { useActorName } from "@marvis/core/workspace/hooks";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

/** Comments shown in the notice before "view all". */
const NOTICE_COMMENTS = 2;

export function isKbReviewNotice(type: InboxItem["type"]): boolean {
  return type === "kb_mr_changes_requested" || type === "kb_mr_review_requested" || type === "kb_mr_review_needed";
}

/** Where a review notification points: the knowledge base and the request number. */
function noticeTarget(item: InboxItem): { slug: string; number: number; reviewId: string } {
  const details = (item.details ?? {}) as Record<string, unknown>;
  const number = Number(details.merge_request_number);

  return {
    slug: typeof details.knowledge_base_slug === "string" ? details.knowledge_base_slug : "",
    number: Number.isInteger(number) && number > 0 ? number : 0,
    reviewId: typeof details.review_id === "string" ? details.review_id : "",
  };
}

/**
 * The review the notice is about: the submitted one, the viewer's own latest
 * when asked to review again, none when asked to approve.
 */
function noticeReview(item: InboxItem, mr: KbMergeRequestDetail, reviewId: string, userId: string): KbMrReview | null {
  if (item.type === "kb_mr_review_needed") return null;
  if (item.type === "kb_mr_changes_requested") return mr.reviews.find((r) => r.id === reviewId) ?? null;
  const mine = mr.reviews.filter((r) => r.reviewer_user_id === userId);

  return mine[mine.length - 1] ?? null;
}

function useNoticeData(item: InboxItem) {
  const target = noticeTarget(item);
  const enabled = !!target.slug && target.number > 0;
  const detail = useQuery({ ...kbMergeRequestOptions(item.workspace_id, target.number), enabled, retry: false });
  const comments = useQuery({ ...kbMrCommentListOptions(item.workspace_id, target.number), enabled: enabled && detail.isSuccess, retry: false });

  return { target, detail, comments };
}

/** What the actor did, after their name. */
function noticeAction(type: InboxItem["type"]) {
  if (type === "kb_mr_changes_requested") return "changes_requested_action" as const;
  if (type === "kb_mr_review_needed") return "review_needed_action" as const;

  return "review_requested_action" as const;
}

/**
 * A knowledge base review notification (decision 107): who did what, the
 * review summary and its first comments, read live from the merge request.
 * When the request is gone or not readable it falls back to the stored body.
 */
export function KbReviewNotice({ item }: { item: InboxItem }) {
  const { t } = useT("inbox");
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const { getActorName } = useActorName();
  const slug = useWorkspaceSlug();
  const { target, detail, comments } = useNoticeData(item);
  const mr = detail.data && detail.data.number === target.number ? detail.data : null;

  if (!mr) {
    return item.body ? (
      <div className="mt-4.5 whitespace-pre-wrap text-body leading-relaxed text-foreground">{item.body}</div>
    ) : null;
  }

  const review = noticeReview(item, mr, target.reviewId, userId);
  const feedback = review ? (comments.data ?? []).filter((c) => c.review_id === review.id) : [];
  // An agent can open a change request; review notices otherwise come from members.
  const actorType = item.actor_type === "agent" ? "agent" : "member";
  const actor = item.actor_id ? getActorName(actorType, item.actor_id) : "";
  const action = noticeAction(item.type);
  const pageTitle = (pageId: string) => mr.pages.find((page) => page.page_id === pageId)?.title || "";
  const href = slug ? paths.workspace(slug).kbMergeRequest(target.slug, target.number) : null;
  const changes = item.type === "kb_mr_changes_requested";

  return (
    <div className="mt-4.5 flex flex-col gap-3.5">
      {actor && (
        <div className="flex items-center gap-2 text-body">
          {item.actor_id && <ActorAvatar actorType={actorType} actorId={item.actor_id} name={actor} size="sm" profileLink={false} />}
          <span>
            <span className="font-medium">{actor}</span> {t(($) => $.kb_review[action])}
          </span>
        </div>
      )}
      {review?.summary && (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-faint-foreground">
            {changes ? t(($) => $.kb_review.summary) : t(($) => $.kb_review.your_summary)}
          </span>
          <div className="rounded-[10px] bg-surface-sunken px-3.5 py-2.5 text-body whitespace-pre-wrap">{review.summary}</div>
        </div>
      )}
      {feedback.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <span className="text-caption text-faint-foreground">{t(($) => $.kb_review.comments)}</span>
          {feedback.slice(0, NOTICE_COMMENTS).map((c) => (
            <div key={c.id} className="flex flex-col gap-1 border-b border-border/60 pb-2.5">
              {c.quote && (
                <span className="truncate rounded-lg bg-surface-sunken px-2 py-1 text-caption text-muted-foreground">
                  {[pageTitle(c.quote.page_id), c.quote.text].filter(Boolean).join(" · ")}
                </span>
              )}
              <span className="text-body break-words whitespace-pre-wrap">{c.body}</span>
            </div>
          ))}
          {feedback.length > NOTICE_COMMENTS && href && (
            <AppLink href={href} className="self-start text-label text-info hover:underline">
              {t(($) => $.kb_review.view_all, { count: feedback.length })}
            </AppLink>
          )}
        </div>
      )}
    </div>
  );
}

/** The notice's primary action: the owner reads the feedback, a reviewer or maintainer reviews. */
export function KbReviewNoticeAction({ item }: { item: InboxItem }) {
  const { t } = useT("inbox");
  const slug = useWorkspaceSlug();
  const { target, detail } = useNoticeData(item);
  // A request that is gone or not readable has nowhere to go.
  if (!slug || detail.data?.number !== target.number || target.number <= 0) return null;

  return (
    <Button render={<AppLink href={paths.workspace(slug).kbMergeRequest(target.slug, target.number)} />} nativeButton={false}>
      {item.type === "kb_mr_changes_requested" ? t(($) => $.kb_review.view_feedback) : t(($) => $.kb_review.go_review)}
    </Button>
  );
}
