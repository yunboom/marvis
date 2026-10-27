"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbMergeRequestOptions, kbMrCommentListOptions } from "@marvis/core/kb/queries";
import { useHandoffKbMrReview } from "@marvis/core/kb/mutations";
import type { KbMergeRequestDetail, KbMrComment, KbMrReview } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { KbStateDot } from "../components/kb-diff";

/**
 * The reviews still to be resolved: submitted after the owner last asked for
 * review again (all of them before the first time).
 */
export function openReviewRound(mr: Pick<KbMergeRequestDetail, "reviews" | "review_requested_at">): KbMrReview[] {
  const since = mr.review_requested_at ? Date.parse(mr.review_requested_at) : Number.NEGATIVE_INFINITY;

  return mr.reviews.filter((r) => r.state === "submitted" && r.submitted_at && Date.parse(r.submitted_at) > since);
}

/**
 * The review feedback of a changes_requested merge request on the job page
 * (design 9.18): each open review's summary and comments, a link to the
 * review page, and handing the feedback to the job's agent.
 */
export function KbJobReviewFeedback({ kbSlug, number }: { kbSlug: string; number: number }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const { data: mr } = useQuery(kbMergeRequestOptions(wsId, number));
  const { data: comments = [] } = useQuery(kbMrCommentListOptions(wsId, number));
  const handoff = useHandoffKbMrReview();

  const round = useMemo(() => (mr ? openReviewRound(mr) : []), [mr]);
  const feedback = useMemo(() => {
    const ids = new Set(round.map((r) => r.id));
    return comments.filter((c): c is KbMrComment & { review_id: string } => !!c.review_id && ids.has(c.review_id));
  }, [comments, round]);

  if (!mr || round.length === 0) return null;

  const pageTitle = (pageId: string) => mr.pages.find((page) => page.page_id === pageId)?.title || "";

  return (
    <section
      aria-label={t(($) => $.job.feedback.label)}
      className="flex shrink-0 flex-col gap-2.5 rounded-xl border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-label">
        <KbStateDot dot="amber" />
        <span className="min-w-0 flex-1 font-semibold">{t(($) => $.job.feedback.title, { number, count: feedback.length })}</span>
        <AppLink href={p.kbMergeRequest(kbSlug, number)} className="shrink-0 text-caption text-info hover:underline">
          {t(($) => $.job.feedback.go_review)}
        </AppLink>
      </div>
      {round.map((review) => (
        <div key={review.id} className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5 text-label">
            <span>
              <span className="font-medium">{review.reviewer_name}</span>
              <span className="text-faint-foreground">
                {" "}
                {t(($) => $.job.feedback.submitted, { time: review.submitted_at ? timeAgo(review.submitted_at) : "" })}
              </span>
            </span>
            {review.summary && <span className="break-words whitespace-pre-wrap">{review.summary}</span>}
          </div>
          {feedback
            .filter((c) => c.review_id === review.id)
            .map((c) => (
              <div key={c.id} className="flex gap-2">
                <ActorAvatar actorType={c.author_type} actorId={c.author_id} name={c.author_name || undefined} size="xs" profileLink={false} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {c.quote && (
                    <span className="truncate rounded-lg bg-surface-sunken px-2 py-1 text-caption text-muted-foreground">
                      {[pageTitle(c.quote.page_id), c.quote.text].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  <span className="text-label break-words whitespace-pre-wrap">{c.body}</span>
                </div>
              </div>
            ))}
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={handoff.isPending}
          onClick={() =>
            handoff.mutate(number, {
              onSuccess: () => toast.success(t(($) => $.job.feedback.handed_off)),
              onError: () => toast.error(t(($) => $.job.feedback.handoff_failed)),
            })
          }
        >
          {handoff.isPending && <Loader2 className="size-4 animate-spin" />}
          {t(($) => $.job.feedback.handoff)}
        </Button>
      </div>
    </section>
  );
}
