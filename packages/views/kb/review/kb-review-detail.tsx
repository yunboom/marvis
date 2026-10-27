"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Loader2, MessageSquare, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import { isImeComposing } from "@marvis/core/utils";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbMergeRequestOptions, kbMrTimelineOptions } from "@marvis/core/kb/queries";
import {
  useCloseKbMergeRequest,
  useCreateKbMrComment,
  useDeleteKbMrComment,
  useDiscardKbMrReview,
  useMergeKbMergeRequest,
  useOpenKbMrReview,
  useRequestKbMrReview,
  useSubmitKbMrReview,
  useUpdateKbMrComment,
} from "@marvis/core/kb/mutations";
import type {
  KbDraftConflict,
  KbDraftPageChange,
  KbMergeRequestDetail,
  KbMrComment,
  KbMrCommentQuote,
  KbMrEvent,
  KbMrTimelineEntry,
} from "@marvis/core/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@marvis/ui/components/ui/popover";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { KB_TAG } from "../components/kb-cite-card";
import { KB_MR_STATUS_DOT, KbFileCard, KbStateDot, useLintText } from "../components/kb-diff";
import { withDraft } from "../components/kb-page-tree";
import { kbErrorCode } from "../utils/kb-api-error";
import { kbOriginHref } from "./kb-review-route";
import { KbRevertDialog, type KbRevertTarget } from "./kb-revert-dialog";

/** Error codes the merge button words itself. */
const MERGE_ERRORS = {
  stale_draft_version: "stale",
  merge_conflict: "conflict",
  unresolved_conflict: "conflict",
  job_running: "running",
  merge_request_not_open: "not_open",
  changes_requested: "changes_requested",
} as const;

type MergeError = (typeof MERGE_ERRORS)[keyof typeof MERGE_ERRORS];

function mergeError(error: unknown): MergeError | "failed" {
  const code = kbErrorCode(error);

  return Object.hasOwn(MERGE_ERRORS, code) ? MERGE_ERRORS[code as keyof typeof MERGE_ERRORS] : "failed";
}

/** The newest activity entries shown before "show earlier". */
const VISIBLE_ACTIVITY = 5;

/** A comment's quote as it is about to be sent: the line and where it is. */
interface DraftQuote {
  quote: KbMrCommentQuote;
  pageTitle: string;
  line: number;
}

/** A selected diff line: which card and which line of it. */
interface LineSelection {
  pageId: string;
  index: number;
}

/** A root comment with its replies, or an event, in timeline order. */
type ActivityItem = { kind: "thread"; root: KbMrComment; replies: KbMrComment[] } | { kind: "event"; event: KbMrEvent };

function toComment(entry: Extract<KbMrTimelineEntry, { type: "comment" }>): KbMrComment {
  const { type: _type, ...comment } = entry;

  return comment;
}

/** Groups the timeline into threads (replies under their root) and events. */
function activityItems(timeline: KbMrTimelineEntry[]): ActivityItem[] {
  const comments = timeline.filter((e): e is Extract<KbMrTimelineEntry, { type: "comment" }> => e.type === "comment").map(toComment);
  const replies = new Map<string, KbMrComment[]>();
  for (const c of comments) {
    if (!c.parent_id) continue;
    replies.set(c.parent_id, [...(replies.get(c.parent_id) ?? []), c]);
  }

  const out: ActivityItem[] = [];
  for (const entry of timeline) {
    if (entry.type === "event") {
      if (entry.kind !== "unknown") out.push({ kind: "event", event: entry });
      continue;
    }
    if (!entry.parent_id) out.push({ kind: "thread", root: toComment(entry), replies: replies.get(entry.id) ?? [] });
  }

  return out;
}

/** Words a merge request source; an unknown one shows as sent. */
export function useKbSourceLabel(): (source: string) => string {
  const { t } = useT("kb");

  return (source) => {
    switch (source) {
      case "ingest":
      case "health":
      case "merge":
      case "annotations":
      case "new_page":
      case "revert":
      case "custom":
        return t(($) => $.review.source[source]);
      default:
        return source;
    }
  };
}

function OriginLink({ kbSlug, mr }: { kbSlug: string; mr: KbMergeRequestDetail }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const href = kbOriginHref(p, kbSlug, mr.origin, mr.reverts);
  if (mr.origin.type === "none" || !href) return null;

  const label =
    mr.origin.type === "revert"
      ? t(($) => $.review.origin.revert, { number: mr.reverts ?? 0 })
      : t(($) => $.review.origin[mr.origin.type as "kb_job" | "autopilot_run" | "issue" | "chat"], { label: mr.origin.label });

  return (
    <AppLink href={href} className="min-w-0 truncate text-info hover:underline">
      {label}
    </AppLink>
  );
}

function ConflictBanner({ conflicts, pages }: { conflicts: KbDraftConflict[]; pages: KbDraftPageChange[] }) {
  const { t } = useT("kb");
  const titleOf = (pageId: string, path: string) => pages.find((page) => page.page_id === pageId)?.title || path;

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-label">
      <div className="flex items-center gap-2.5">
        <KbStateDot dot="red" />
        <span className="flex-1">{t(($) => $.review.conflict_banner)}</span>
      </div>
      {conflicts.map((conflict, index) => (
        <div key={index} className="flex items-center gap-3.5 pl-4 text-caption">
          <span className="min-w-0 flex-1 truncate">{titleOf(conflict.page_id, conflict.path)}</span>
          {conflict.main_lines && (
            <span className="text-muted-foreground">{t(($) => $.review.conflict_main, { lines: conflict.main_lines })}</span>
          )}
          {conflict.draft_lines && (
            <span className="text-muted-foreground">{t(($) => $.review.conflict_draft, { lines: conflict.draft_lines })}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function QuoteChip({ text, label, onRemove }: { text: string; label: string; onRemove?: () => void }) {
  const { t } = useT("kb");

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-surface-sunken px-2 py-1.5 text-caption text-muted-foreground">
      <span className="shrink-0 text-faint-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {onRemove && (
        <button type="button" aria-label={t(($) => $.review.remove_quote)} onClick={onRemove} className="shrink-0 hover:text-foreground">
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** A small text box that sends on Cmd/Ctrl+Enter or with its button. */
function InlineEditor({
  label,
  initial = "",
  submitLabel,
  sending,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  submitLabel: string;
  sending: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useT("kb");
  const [body, setBody] = useState(initial);
  const canSend = !!body.trim() && !sending;
  const send = () => {
    if (!canSend) return;
    void onSubmit(body.trim()).then((ok) => {
      if (ok) setBody("");
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        autoFocus
        rows={2}
        value={body}
        readOnly={sending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || isImeComposing(event.nativeEvent)) return;
          event.preventDefault();
          send();
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t(($) => $.review.cancel)}
        </Button>
        <Button type="button" size="sm" disabled={!canSend} onClick={send}>
          {sending && <Loader2 className="size-3.5 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function CommentBody({
  number,
  comment,
  pageTitle,
}: {
  number: number;
  comment: KbMrComment;
  pageTitle: (pageId: string) => string;
}) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const update = useUpdateKbMrComment();
  const remove = useDeleteKbMrComment();
  const [editing, setEditing] = useState(false);
  const pending = comment.state === "pending";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-label">
        <ActorAvatar actorType={comment.author_type} actorId={comment.author_id} name={comment.author_name || undefined} size="xs" profileLink={false} />
        <span className="font-medium">{comment.author_name}</span>
        <span className="text-caption text-faint-foreground">{timeAgo(comment.created_at)}</span>
        {pending && (
          <>
            <span className={cn(KB_TAG, "h-5 text-caption")}>{t(($) => $.review.pending)}</span>
            <span className="flex-1" />
            <button type="button" onClick={() => setEditing(true)} className="text-caption text-info hover:underline">
              {t(($) => $.review.edit)}
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { number, commentId: comment.id },
                  { onError: () => toast.error(t(($) => $.review.comment_failed)) },
                )
              }
              className="text-caption text-info hover:underline"
            >
              {t(($) => $.review.delete)}
            </button>
          </>
        )}
      </div>
      {comment.quote && <QuoteChip label={pageTitle(comment.quote.page_id)} text={comment.quote.text} />}
      {editing ? (
        <InlineEditor
          label={t(($) => $.review.comment_label)}
          initial={comment.body}
          submitLabel={t(($) => $.review.save)}
          sending={update.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(body) =>
            update
              .mutateAsync({ number, commentId: comment.id, body })
              .then(() => {
                setEditing(false);
                return true;
              })
              .catch(() => {
                toast.error(t(($) => $.review.comment_failed));
                return false;
              })
          }
        />
      ) : (
        <p className="text-body break-words whitespace-pre-wrap">{comment.body}</p>
      )}
    </div>
  );
}

function CommentCard({
  number,
  comment,
  replies,
  pageTitle,
  onReply,
  canReplyInline,
}: {
  number: number;
  comment: KbMrComment;
  replies: KbMrComment[];
  pageTitle: (pageId: string) => string;
  /** Replies through the review's comment box; null when the viewer cannot. */
  onReply: ((comment: KbMrComment) => void) | null;
  /** The owner answers right in the thread. */
  canReplyInline: boolean;
}) {
  const { t } = useT("kb");
  const reply = useCreateKbMrComment();
  const [replying, setReplying] = useState(false);
  const published = comment.state === "published";

  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card px-3.5 py-3">
      <CommentBody number={number} comment={comment} pageTitle={pageTitle} />
      {replies.map((r) => (
        <div key={r.id} className="border-t border-border/60 pt-3 pl-6">
          <CommentBody number={number} comment={r} pageTitle={pageTitle} />
        </div>
      ))}
      {published && canReplyInline && (
        <div className="border-t border-border/60 pt-2">
          {replying ? (
            <InlineEditor
              label={t(($) => $.review.reply)}
              submitLabel={t(($) => $.review.reply)}
              sending={reply.isPending}
              onCancel={() => setReplying(false)}
              onSubmit={(body) =>
                reply
                  .mutateAsync({ number, data: { body, parent_id: comment.id } })
                  .then(() => {
                    setReplying(false);
                    return true;
                  })
                  .catch(() => {
                    toast.error(t(($) => $.review.comment_failed));
                    return false;
                  })
              }
            />
          ) : (
            <button type="button" onClick={() => setReplying(true)} className="w-full text-left text-label text-faint-foreground hover:text-muted-foreground">
              {t(($) => $.review.reply_placeholder)}
            </button>
          )}
        </div>
      )}
      {published && onReply && (
        <button type="button" onClick={() => onReply(comment)} className="self-start text-caption text-info hover:underline">
          {t(($) => $.review.reply)}
        </button>
      )}
    </article>
  );
}

function EventRow({ event }: { event: KbMrEvent }) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const payload = event.payload;
  const count = typeof payload.comment_count === "number" ? payload.comment_count : 0;
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const reason = typeof payload.close_reason === "string" ? payload.close_reason : "";
  const revertNumber = typeof payload.revert_number === "number" ? payload.revert_number : 0;
  const fields = Array.isArray(payload.fields)
    ? payload.fields.filter((f): f is "title" | "summary" | "risk" => f === "title" || f === "summary" || f === "risk")
    : [];

  let text = "";
  switch (event.kind) {
    case "review_submitted":
      text = t(($) => $.review.event.review_submitted, { count });
      break;
    case "review_requested":
      text = t(($) => $.review.event.review_requested);
      break;
    case "merged":
      text = t(($) => $.review.event.merged);
      break;
    case "closed":
      text = t(($) => $.review.event.closed);
      break;
    case "reverted":
      text = t(($) => $.review.event.reverted, { number: revertNumber });
      break;
    case "edited":
      text = t(($) => $.review.event.edited, {
        fields: fields.map((f) => t(($) => $.review.field[f])).join(t(($) => $.review.field_separator)),
      });
      break;
  }
  const detail = event.kind === "review_submitted" ? summary : event.kind === "closed" ? reason : "";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 pl-1 text-label">
        <ActorAvatar actorType={event.actor_type} actorId={event.actor_id} name={event.actor_name || undefined} size="xs" profileLink={false} />
        <span className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground">{event.actor_name}</span> {text}
        </span>
        <span className="shrink-0 text-caption text-faint-foreground">{timeAgo(event.created_at)}</span>
      </div>
      {detail && <p className="pl-8 text-label break-words whitespace-pre-wrap">{detail}</p>}
    </div>
  );
}

function ReviewComposer({
  quote,
  replyTo,
  onClearQuote,
  onClearReply,
  onSend,
  sending,
}: {
  quote: DraftQuote | null;
  replyTo: KbMrComment | null;
  onClearQuote: () => void;
  onClearReply: () => void;
  onSend: (body: string) => Promise<boolean>;
  sending: boolean;
}) {
  const { t } = useT("kb");
  const [body, setBody] = useState("");
  const canSend = !!body.trim();
  const send = () => {
    if (!canSend || sending) return;
    void onSend(body.trim()).then((ok) => {
      if (ok) setBody("");
    });
  };

  return (
    <div
      data-slot="comment-composer"
      className="relative flex max-w-[720px] flex-col rounded-[22px] border border-input bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_20px_rgb(0_0_0/0.05)] transition-[border-color,box-shadow] duration-(--motion-fast) ease-out focus-within:border-ring focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_28px_rgb(0_0_0/0.07)]"
    >
      {(replyTo || quote) && (
        <div className="flex flex-col gap-1.5 px-3.5 pt-3">
          {replyTo && (
            <QuoteChip label={t(($) => $.review.replying_to, { name: replyTo.author_name })} text={replyTo.body} onRemove={onClearReply} />
          )}
          {quote && (
            <QuoteChip
              label={t(($) => $.review.quote_line, { page: quote.pageTitle, line: quote.line })}
              text={quote.quote.text}
              onRemove={onClearQuote}
            />
          )}
        </div>
      )}
      {/* Plain text, with the issue composer's editor line metrics. Locked
          and dimmed while the send is in flight so a success can't clear
          text typed after it started. */}
      <div className={cn("min-h-0 px-4 pt-3.5 pb-1", sending && "pointer-events-none opacity-60")} aria-busy={sending || undefined}>
        <textarea
          aria-label={t(($) => $.review.comment_label)}
          placeholder={t(($) => $.review.comment_placeholder)}
          rows={1}
          value={body}
          readOnly={sending}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || isImeComposing(event.nativeEvent)) return;
            event.preventDefault();
            send();
          }}
          className="block field-sizing-content max-h-[40vh] w-full resize-none border-0 bg-transparent p-0 text-body leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div data-slot="comment-composer-toolbar" className="flex min-w-0 items-center justify-end gap-1 px-2 pb-2">
        <Button type="button" variant="outline" size="sm" disabled={!canSend} aria-busy={sending || undefined} onClick={send}>
          {sending && <Loader2 className="size-3.5 animate-spin" />}
          {t(($) => $.review.add_to_review)}
        </Button>
      </div>
    </div>
  );
}

/** The review bar: what is pending, submit with an optional summary, or discard. */
function ReviewBar({
  number,
  reviewId,
  pendingCount,
}: {
  number: number;
  reviewId: string;
  pendingCount: number;
}) {
  const { t } = useT("kb");
  const submit = useSubmitKbMrReview();
  const discard = useDiscardKbMrReview();
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [summary, setSummary] = useState("");
  const canSubmit = (pendingCount > 0 || !!summary.trim()) && !submit.isPending;

  const doSubmit = () => {
    submit.mutate(
      { number, reviewId, summary: summary.trim() },
      {
        onSuccess: () => {
          setSubmitting(false);
          setSummary("");
          toast.success(t(($) => $.review.submitted_toast));
        },
        onError: () => toast.error(t(($) => $.review.submit_failed)),
      },
    );
  };

  return (
    <div className="flex max-w-[720px] items-center gap-2 text-label">
      <span className={cn(KB_TAG, "gap-1.5")}>
        <KbStateDot dot="amber" />
        {t(($) => $.review.reviewing)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {pendingCount > 0 ? t(($) => $.review.pending_count, { count: pendingCount }) : t(($) => $.review.pending_none)}
      </span>
      <Button type="button" variant="ghost" onClick={() => setDiscarding(true)}>
        {t(($) => $.review.discard)}
      </Button>
      <Popover open={submitting} onOpenChange={setSubmitting}>
        <PopoverTrigger render={<Button type="button" />}>
          {pendingCount > 0 ? t(($) => $.review.submit_count, { count: pendingCount }) : t(($) => $.review.submit)}
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="flex w-[360px] flex-col gap-2.5 p-4">
          <div className="text-body font-semibold">{t(($) => $.review.submit)}</div>
          <Textarea
            aria-label={t(($) => $.review.summary_label)}
            placeholder={t(($) => $.review.summary_label)}
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <p className="text-caption text-muted-foreground">{t(($) => $.review.submit_note, { count: pendingCount })}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setSubmitting(false)}>
              {t(($) => $.review.cancel)}
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={doSubmit}>
              {submit.isPending && <Loader2 className="size-4 animate-spin" />}
              {t(($) => $.review.submit)}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={discarding}
        onOpenChange={(next) => {
          if (!next && !discard.isPending) setDiscarding(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.review.discard_confirm_title)}</AlertDialogTitle>
            {pendingCount > 0 && (
              <AlertDialogDescription>{t(($) => $.review.discard_confirm_description, { count: pendingCount })}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discard.isPending}>{t(($) => $.review.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={discard.isPending}
              onClick={(event) => {
                event.preventDefault();
                discard.mutate(
                  { number, reviewId },
                  {
                    onSuccess: () => setDiscarding(false),
                    onError: () => toast.error(t(($) => $.review.discard_failed)),
                  },
                );
              }}
            >
              {discard.isPending && <Loader2 className="size-4 animate-spin" />}
              {t(($) => $.review.discard)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One merge request (designs 8.1–8.12): who opened it and from where, merge
 * and close, the conflict banner, the agent's summary and the checks, the
 * file cards, and the activity (comments and events). A reviewer opens a
 * review, quotes diff lines into pending comments only they see and submits
 * them at once; the owner replies in the threads and asks for review again.
 * A merged request offers revert instead.
 */
export function KbReviewDetail({ kbSlug, number }: { kbSlug: string; number: number }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const lintText = useLintText();
  const sourceLabel = useKbSourceLabel();
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const { data: mr, isLoading, isError } = useQuery(kbMergeRequestOptions(wsId, number));
  const { data: timeline = [] } = useQuery(kbMrTimelineOptions(wsId, number, "all"));
  const merge = useMergeKbMergeRequest();
  const close = useCloseKbMergeRequest();
  const comment = useCreateKbMrComment();
  const openReview = useOpenKbMrReview();
  const requestReview = useRequestKbMrReview();

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [quote, setQuote] = useState<DraftQuote | null>(null);
  const [replyTo, setReplyTo] = useState<KbMrComment | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [reverting, setReverting] = useState<KbRevertTarget | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  const items = useMemo(() => activityItems(timeline), [timeline]);
  const pendingCount = useMemo(
    () => timeline.filter((e) => e.type === "comment" && e.state === "pending").length,
    [timeline],
  );

  if (!mr || mr.number !== number) {
    return (
      <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
        {isLoading && !isError ? <Loader2 className="size-4 animate-spin" /> : t(($) => $.review.not_found)}
      </div>
    );
  }

  const open = mr.status === "open";
  const changesRequested = mr.status === "changes_requested";
  const active = open || changesRequested;
  const isOwner = !!userId && mr.owner_id === userId;
  const review = mr.pending_review;
  const reviewing = !!review && active;
  const canStartReview = open && mr.can_review && !review && !isOwner;
  const conflicts = active ? mr.checks.conflicts : [];
  const lintErrors = mr.checks.lint.filter((f) => f.severity === "error").length;
  const canMerge = open && mr.can_merge && !mr.agent_running && conflicts.length === 0 && lintErrors === 0;
  const pageTitle = (pageId: string) => mr.pages.find((page) => page.page_id === pageId)?.title || pageId;

  const mergeHint = changesRequested
    ? isOwner
      ? t(($) => $.review.hint_changes_owner)
      : t(($) => $.review.hint_changes)
    : !open
      ? ""
      : !mr.can_merge
        ? t(($) => $.review.hint_member)
        : conflicts.length > 0
          ? t(($) => $.review.hint_conflict)
          : mr.agent_running
            ? t(($) => $.review.hint_running)
            : "";

  const ensureReview = (): Promise<string | null> => {
    if (review) return Promise.resolve(review.id);

    return openReview
      .mutateAsync(number)
      .then((r) => r.id)
      .catch(() => {
        toast.error(t(($) => $.review.start_failed));
        return null;
      });
  };

  const sendReviewComment = (body: string): Promise<boolean> =>
    ensureReview().then((reviewId) => {
      if (!reviewId) return false;

      return comment
        .mutateAsync({
          number,
          data: { body, review_id: reviewId, parent_id: replyTo?.id ?? null, quote: quote?.quote ?? null },
        })
        .then(() => {
          setQuote(null);
          setReplyTo(null);
          setSelection(null);
          return true;
        })
        .catch(() => {
          toast.error(t(($) => $.review.comment_failed));
          return false;
        });
    });

  const doMerge = () => {
    merge.mutate(
      { number, draftVersion: mr.draft_version },
      {
        onSuccess: () => toast.success(t(($) => $.review.merged_toast, { number })),
        onError: (error) => toast.error(t(($) => $.review.merge_error[mergeError(error)])),
      },
    );
  };

  const doClose = () => {
    close.mutate(
      { number, reason: closeReason.trim() },
      {
        onSuccess: () => {
          setConfirmingClose(false);
          setCloseReason("");
        },
        onError: () => toast.error(t(($) => $.review.close_failed)),
      },
    );
  };

  const doRequestReview = () => {
    requestReview.mutate(number, { onError: () => toast.error(t(($) => $.review.ready_failed)) });
  };

  const addComment = () => {
    if (!selection) return;
    const page = mr.pages.find((pg) => pg.page_id === selection.pageId);
    const line = page?.lines[selection.index];
    if (!page || !line) return;
    setQuote({
      quote: { page_id: page.page_id, block_id: line.block_id, text: line.text },
      pageTitle: page.title || page.path,
      line: line.new_line || line.old_line,
    });
    setSelection(null);
    if (!review) void ensureReview();
  };

  const summaryMeta = [
    t(($) => $.review.meta, { risk: t(($) => $.review.risk[mr.risk === "high" || mr.risk === "medium" ? mr.risk : "low"]), count: mr.pages.length }),
    mr.annotation_ids.length > 0 ? t(($) => $.review.meta_annotations, { count: mr.annotation_ids.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const hiddenCount = showEarlier ? 0 : Math.max(0, items.length - VISIBLE_ACTIVITY);
  const visibleItems = hiddenCount > 0 ? items.slice(-VISIBLE_ACTIVITY) : items;
  // Diff lines quote into a review: a reviewer who can review, not the owner.
  const canQuote = active && mr.can_review && !isOwner && (open || reviewing);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[30px] py-[22px]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-label text-muted-foreground">
              <span className="font-mono">#{mr.number}</span>
              <span>{sourceLabel(mr.source)}</span>
              <span aria-hidden="true">·</span>
              <ActorAvatar actorType={mr.author_type} actorId={mr.author_id} name={mr.author_name || undefined} size="xs" profileLink={false} />
              <span className="text-foreground">{mr.author_name}</span>
              <span aria-hidden="true">·</span>
              <span>{timeAgo(mr.created_at)}</span>
              <OriginLink kbSlug={kbSlug} mr={mr} />
            </div>
            <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
              <h2 className="min-w-0 text-title font-semibold break-words">{mr.title}</h2>
              <span className={cn(KB_TAG, "shrink-0 gap-1.5")}>
                <KbStateDot dot={KB_MR_STATUS_DOT[mr.status]} />
                {t(($) => $.review.status[mr.status])}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {open && mr.agent_running && (
                <span className={cn(KB_TAG, "h-7 gap-1.5 px-2.5")}>
                  <KbStateDot dot="green" />
                  {t(($) => $.review.agent_working)}
                </span>
              )}
              {canStartReview && (
                <Button type="button" variant="outline" disabled={openReview.isPending} onClick={() => void ensureReview()}>
                  {openReview.isPending && <Loader2 className="size-4 animate-spin" />}
                  {t(($) => $.review.start)}
                </Button>
              )}
              {mr.can_request_review && (
                <Button type="button" variant="outline" disabled={requestReview.isPending} onClick={doRequestReview}>
                  {requestReview.isPending && <Loader2 className="size-4 animate-spin" />}
                  {t(($) => $.review.request_review)}
                </Button>
              )}
              {active && mr.can_close && (
                <Button type="button" variant="outline" disabled={close.isPending} onClick={() => setConfirmingClose(true)}>
                  {t(($) => $.review.close)}
                </Button>
              )}
              {active && (
                <Button type="button" disabled={!canMerge || merge.isPending} onClick={doMerge}>
                  {merge.isPending && <Loader2 className="size-4 animate-spin" />}
                  {t(($) => $.review.merge)}
                </Button>
              )}
              {mr.status === "merged" && mr.can_revert && (
                <Button type="button" variant="outline" onClick={() => setReverting({ number: mr.number, title: mr.title })}>
                  {t(($) => $.review.revert)}
                </Button>
              )}
            </div>
            {mergeHint && <span className="text-caption text-faint-foreground">{mergeHint}</span>}
            {mr.status === "merged" && mr.merged_at && (
              <span className="text-caption text-faint-foreground">
                {t(($) => $.review.merged_by, { name: mr.merged_by_name, time: timeAgo(mr.merged_at) })}
              </span>
            )}
            {mr.status === "closed" && mr.closed_at && (
              <span className="text-caption text-faint-foreground">
                {mr.close_reason
                  ? t(($) => $.review.closed_by_reason, { name: mr.closed_by_name, time: timeAgo(mr.closed_at), reason: mr.close_reason })
                  : t(($) => $.review.closed_by, { name: mr.closed_by_name, time: timeAgo(mr.closed_at) })}
              </span>
            )}
          </div>
        </div>

        {conflicts.length > 0 && <ConflictBanner conflicts={conflicts} pages={mr.pages} />}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="h-[148px] overflow-y-auto rounded-xl bg-surface-sunken/60 px-4 py-3.5">
            <div className="mb-1.5 text-caption text-faint-foreground">
              {mr.author_type === "agent" ? t(($) => $.review.self_check) : t(($) => $.review.summary)}
            </div>
            <p className="text-label leading-relaxed break-words whitespace-pre-wrap">{mr.summary}</p>
            <div className="mt-2 text-caption text-muted-foreground">{summaryMeta}</div>
          </div>
          <div className="flex h-[148px] flex-col gap-1.5 overflow-y-auto rounded-xl bg-surface-sunken/60 px-4 py-3.5">
            <div className="text-caption text-faint-foreground">{t(($) => $.review.checks)}</div>
            {active ? (
              <>
                {mr.checks.lint.map((finding, index) => (
                  <span key={index} className="flex items-start gap-2 text-label">
                    <span className="flex h-lh shrink-0 items-center">
                      <KbStateDot dot={finding.severity === "error" ? "red" : "amber"} />
                    </span>
                    <span className="min-w-0 flex-1 break-words">{lintText(finding)}</span>
                  </span>
                ))}
                {mr.checks.lint.length === 0 && (
                  <span className="flex items-center gap-2 text-label">
                    <KbStateDot dot="green" />
                    {t(($) => $.job.draft.lint_ok)}
                  </span>
                )}
                <span className="flex items-center gap-2 text-label">
                  <KbStateDot dot={conflicts.length > 0 ? "red" : "green"} />
                  {conflicts.length > 0 ? t(($) => $.review.conflicting) : t(($) => $.review.mergeable)}
                </span>
              </>
            ) : (
              <span className="flex items-center gap-2 text-label">
                <KbStateDot dot={KB_MR_STATUS_DOT[mr.status]} />
                {t(($) => $.review.status[mr.status])}
              </span>
            )}
          </div>
        </div>

        <div className="mt-1 text-label font-semibold">{mr.knowledge_base_name}</div>
        {mr.pages.map((page) => (
          <KbFileCard
            key={page.page_id}
            page={page}
            open={!collapsed.has(page.page_id)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(page.page_id)) next.delete(page.page_id);
                else next.add(page.page_id);
                return next;
              })
            }
            href={active ? withDraft(p.kbPage(kbSlug, page.page_id), mr.draft_id) : p.kbPage(kbSlug, page.page_id)}
            selectedLine={canQuote && selection?.pageId === page.page_id ? selection.index : -1}
            onSelectLine={(index) => {
              if (!canQuote) return;
              setSelection((prev) => (prev?.pageId === page.page_id && prev.index === index ? null : { pageId: page.page_id, index }));
            }}
            lineAction={
              <Button type="button" size="xs" onClick={addComment} className="shadow-md">
                <MessageSquare className="size-3" />
                {t(($) => $.review.add_comment)}
              </Button>
            }
          />
        ))}

        <section aria-label={t(($) => $.review.activity)} className="mt-2 flex max-w-[720px] flex-col gap-3 border-t pt-4">
          <h3 className="text-body font-semibold">{t(($) => $.review.activity)}</h3>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlier(true)}
              className="flex items-center gap-1.5 self-start text-label text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:text-foreground"
            >
              <ChevronRight className="size-3 shrink-0" />
              {t(($) => $.review.show_earlier, { count: hiddenCount })}
            </button>
          )}
          {visibleItems.map((item) =>
            item.kind === "event" ? (
              <EventRow key={item.event.id} event={item.event} />
            ) : (
              <CommentCard
                key={item.root.id}
                number={number}
                comment={item.root}
                replies={item.replies}
                pageTitle={pageTitle}
                onReply={reviewing ? setReplyTo : null}
                canReplyInline={isOwner && active}
              />
            ),
          )}
        </section>
      </div>

      {reviewing && review && (
        <div className="flex shrink-0 flex-col gap-2.5 px-[30px] pb-5">
          <ReviewBar number={number} reviewId={review.id} pendingCount={pendingCount} />
          <ReviewComposer
            quote={quote}
            replyTo={replyTo}
            onClearQuote={() => setQuote(null)}
            onClearReply={() => setReplyTo(null)}
            onSend={sendReviewComment}
            sending={comment.isPending}
          />
        </div>
      )}

      <AlertDialog
        open={confirmingClose}
        onOpenChange={(next) => {
          if (!next && !close.isPending) setConfirmingClose(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.review.close_confirm_title)}</AlertDialogTitle>
            {mr.annotation_ids.length > 0 && (
              <AlertDialogDescription>
                {t(($) => $.review.close_confirm_annotations, { count: mr.annotation_ids.length })}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <Input
            aria-label={t(($) => $.review.close_reason)}
            placeholder={t(($) => $.review.close_reason)}
            value={closeReason}
            onChange={(event) => setCloseReason(event.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={close.isPending}>{t(($) => $.review.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={close.isPending}
              onClick={(event) => {
                event.preventDefault();
                doClose();
              }}
            >
              {close.isPending && <Loader2 className="size-4 animate-spin" />}
              {t(($) => $.review.close)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <KbRevertDialog kbSlug={kbSlug} target={reverting} onClose={() => setReverting(null)} />
    </div>
  );
}
