"use client";

import { useMemo, useState } from "react";
import { ArrowUp, Loader2, MessageSquare, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbMergeRequestOptions, kbMrCommentListOptions } from "@marvis/core/kb/queries";
import { useCloseKbMergeRequest, useCreateKbMrComment, useMergeKbMergeRequest } from "@marvis/core/kb/mutations";
import type {
  KbDraftConflict,
  KbDraftPageChange,
  KbMergeRequestDetail,
  KbMrComment,
  KbMrCommentQuote,
  KbMrCommentTrigger,
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
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { KB_TAG } from "../components/kb-cite-card";
import { KbFileCard, KbStateDot, useLintText, type KbDot } from "../components/kb-diff";
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
} as const;

type MergeError = (typeof MERGE_ERRORS)[keyof typeof MERGE_ERRORS];

function mergeError(error: unknown): MergeError | "failed" {
  const code = kbErrorCode(error);

  return Object.hasOwn(MERGE_ERRORS, code) ? MERGE_ERRORS[code as keyof typeof MERGE_ERRORS] : "failed";
}

const STATUS_DOT: Record<KbMergeRequestDetail["status"], KbDot> = { open: "blue", merged: "green", closed: "gray" };

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

function ConflictBanner({
  conflicts,
  pages,
  onRebase,
  canRebase,
}: {
  conflicts: KbDraftConflict[];
  pages: KbDraftPageChange[];
  onRebase: () => void;
  canRebase: boolean;
}) {
  const { t } = useT("kb");
  const titleOf = (pageId: string, path: string) => pages.find((page) => page.page_id === pageId)?.title || path;

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-label">
      <div className="flex items-center gap-2.5">
        <KbStateDot dot="red" />
        <span className="flex-1">{t(($) => $.review.conflict_banner)}</span>
        {canRebase && (
          <Button type="button" variant="outline" size="xs" onClick={onRebase}>
            {t(($) => $.job.draft.rebase)}
          </Button>
        )}
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

function TriggerRow({
  kbSlug,
  mr,
  trigger,
}: {
  kbSlug: string;
  mr: KbMergeRequestDetail;
  trigger: KbMrCommentTrigger;
}) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  // The job's agent works in the job's chat, which only opens from the job page.
  const jobRun = mr.origin.type === "kb_job" && !!mr.origin.ref_id && trigger.agent_id === mr.review_agent?.id;
  const runHref = jobRun
    ? mr.origin.openable && mr.origin.ref_id
      ? p.kbJob(kbSlug, mr.origin.ref_id)
      : null
    : trigger.chat_session_id
        ? p.chatSession(trigger.chat_session_id)
        : null;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 pt-2 text-label">
      <ActorAvatar actorType="agent" actorId={trigger.agent_id} name={trigger.agent_name || undefined} size="xs" profileLink={false} />
      <span className="font-medium">{trigger.agent_name}</span>
      {trigger.running ? (
        <span className={cn(KB_TAG, "gap-1.5")}>
          <KbStateDot dot="green" />
          {t(($) => $.review.working)}
        </span>
      ) : (
        <span className="text-caption text-faint-foreground">{t(($) => $.review.trigger_reason[trigger.reason === "mention" ? "mention" : "author"])}</span>
      )}
      <span className="flex-1" />
      {runHref && (
        <AppLink href={runHref} className="shrink-0 text-caption text-info hover:underline">
          {t(($) => $.review.view_run)}
        </AppLink>
      )}
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

function CommentCard({
  kbSlug,
  mr,
  comment,
  replies,
  pageTitle,
  onReply,
}: {
  kbSlug: string;
  mr: KbMergeRequestDetail;
  comment: KbMrComment;
  replies: KbMrComment[];
  pageTitle: (pageId: string) => string;
  onReply: (comment: KbMrComment) => void;
}) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();

  const body = (c: KbMrComment) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-label">
        <ActorAvatar actorType={c.author_type} actorId={c.author_id} name={c.author_name || undefined} size="xs" profileLink={false} />
        <span className="font-medium">{c.author_name}</span>
        <span className="text-caption text-faint-foreground">{timeAgo(c.created_at)}</span>
      </div>
      {c.quote && <QuoteChip label={pageTitle(c.quote.page_id)} text={c.quote.text} />}
      <p className="text-body break-words whitespace-pre-wrap">{c.body}</p>
      {c.triggered.map((trigger) => (
        <TriggerRow key={trigger.agent_id + (trigger.task_id ?? "")} kbSlug={kbSlug} mr={mr} trigger={trigger} />
      ))}
    </div>
  );

  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card px-3.5 py-3">
      {body(comment)}
      {replies.map((reply) => (
        <div key={reply.id} className="border-t border-border/60 pt-3 pl-6">
          {body(reply)}
        </div>
      ))}
      <button type="button" onClick={() => onReply(comment)} className="self-start text-caption text-info hover:underline">
        {t(($) => $.review.reply)}
      </button>
    </article>
  );
}

function Composer({
  mr,
  quote,
  replyTo,
  onClearQuote,
  onClearReply,
  onSend,
  sending,
}: {
  mr: KbMergeRequestDetail;
  quote: DraftQuote | null;
  replyTo: KbMrComment | null;
  onClearQuote: () => void;
  onClearReply: () => void;
  onSend: (body: string) => Promise<boolean>;
  sending: boolean;
}) {
  const { t } = useT("kb");
  const [body, setBody] = useState("");
  const send = () => {
    if (!body.trim() || sending) return;
    void onSend(body.trim()).then((ok) => {
      if (ok) setBody("");
    });
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-2.5 rounded-2xl border bg-card px-3.5 pt-3 pb-2.5 shadow-sm">
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
      <Textarea
        aria-label={t(($) => $.review.comment_label)}
        placeholder={t(($) => $.review.comment_placeholder)}
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
        }}
        className="min-h-0 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
      />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1">
          {mr.review_agent && mr.status === "open" && (
            <span className={cn(KB_TAG, "gap-1.5")}>
              <ActorAvatar actorType="agent" actorId={mr.review_agent.id} name={mr.review_agent.name || undefined} size="xs" profileLink={false} />
              {mr.review_agent.name}
              <span className="text-faint-foreground">{t(($) => $.review.trigger_hint)}</span>
            </span>
          )}
        </span>
        <Button
          type="button"
          size="icon-sm"
          aria-label={t(($) => $.review.send)}
          disabled={!body.trim() || sending}
          onClick={send}
          className="rounded-full"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * One merge request (designs 8.2–8.8): who opened it and from where, merge
 * and close, the conflict banner, the agent's summary and the checks, the
 * file cards (select a line to quote it), the comment thread and the
 * comment box. A merged request offers revert instead.
 */
export function KbReviewDetail({ kbSlug, number }: { kbSlug: string; number: number }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const lintText = useLintText();
  const sourceLabel = useKbSourceLabel();
  const { data: mr, isLoading, isError } = useQuery(kbMergeRequestOptions(wsId, number));
  const { data: comments = [] } = useQuery(kbMrCommentListOptions(wsId, number));
  const merge = useMergeKbMergeRequest();
  const close = useCloseKbMergeRequest();
  const comment = useCreateKbMrComment();

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [quote, setQuote] = useState<DraftQuote | null>(null);
  const [replyTo, setReplyTo] = useState<KbMrComment | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [reverting, setReverting] = useState<KbRevertTarget | null>(null);

  const threads = useMemo(() => {
    const roots = comments.filter((c) => !c.parent_id);
    return roots.map((root) => ({ root, replies: comments.filter((c) => c.parent_id === root.id) }));
  }, [comments]);

  if (!mr || mr.number !== number) {
    return (
      <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
        {isLoading && !isError ? <Loader2 className="size-4 animate-spin" /> : t(($) => $.review.not_found)}
      </div>
    );
  }

  const open = mr.status === "open";
  const conflicts = open ? mr.checks.conflicts : [];
  const lintErrors = mr.checks.lint.filter((f) => f.severity === "error").length;
  const canMerge = open && mr.can_merge && !mr.agent_running && conflicts.length === 0 && lintErrors === 0;
  const pageTitle = (pageId: string) => mr.pages.find((page) => page.page_id === pageId)?.title || pageId;

  const mergeHint = !open
    ? ""
    : !mr.can_merge
      ? t(($) => $.review.hint_member)
      : conflicts.length > 0
        ? t(($) => $.review.hint_conflict)
        : mr.agent_running
          ? t(($) => $.review.hint_running)
          : "";

  const sendComment = (body: string): Promise<boolean> =>
    comment
      .mutateAsync({
        number,
        data: { body, parent_id: replyTo?.id ?? null, quote: quote?.quote ?? null },
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
  };

  const summaryMeta = [
    t(($) => $.review.meta, { risk: t(($) => $.review.risk[mr.risk === "high" || mr.risk === "medium" ? mr.risk : "low"]), count: mr.pages.length }),
    mr.annotation_ids.length > 0 ? t(($) => $.review.meta_annotations, { count: mr.annotation_ids.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

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
            <h2 className="mt-1.5 text-title font-semibold break-words">{mr.title}</h2>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {open && mr.agent_running && mr.review_agent && (
                <span className={cn(KB_TAG, "h-7 gap-1.5 px-2.5")}>
                  <KbStateDot dot="green" />
                  {t(($) => $.review.agent_working, { name: mr.review_agent.name })}
                </span>
              )}
              {!open && (
                <span className={cn(KB_TAG, "gap-1.5")}>
                  <KbStateDot dot={STATUS_DOT[mr.status]} />
                  {t(($) => $.review.status[mr.status])}
                </span>
              )}
              {open && mr.can_close && (
                <Button type="button" variant="outline" disabled={close.isPending} onClick={() => setConfirmingClose(true)}>
                  {t(($) => $.review.close)}
                </Button>
              )}
              {open && (
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

        {conflicts.length > 0 && (
          <ConflictBanner
            conflicts={conflicts}
            pages={mr.pages}
            canRebase={!!mr.review_agent && !mr.agent_running}
            onRebase={() => void sendComment(t(($) => $.job.draft.rebase_message, { draft: mr.draft_id }))}
          />
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-surface-sunken/60 px-4 py-3.5">
            <div className="mb-1.5 text-caption text-faint-foreground">
              {mr.author_type === "agent" ? t(($) => $.review.self_check) : t(($) => $.review.summary)}
            </div>
            <p className="text-label leading-relaxed break-words whitespace-pre-wrap">{mr.summary}</p>
            <div className="mt-2 text-caption text-muted-foreground">{summaryMeta}</div>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-surface-sunken/60 px-4 py-3.5">
            <div className="text-caption text-faint-foreground">{t(($) => $.review.checks)}</div>
            {open ? (
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
                <KbStateDot dot={STATUS_DOT[mr.status]} />
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
            href={open ? withDraft(p.kbPage(kbSlug, page.page_id), mr.draft_id) : p.kbPage(kbSlug, page.page_id)}
            selectedLine={selection?.pageId === page.page_id ? selection.index : -1}
            onSelectLine={(index) =>
              setSelection((prev) => (prev?.pageId === page.page_id && prev.index === index ? null : { pageId: page.page_id, index }))
            }
            lineAction={
              <Button type="button" size="xs" onClick={addComment} className="shadow-md">
                <MessageSquare className="size-3" />
                {t(($) => $.review.add_comment)}
              </Button>
            }
          />
        ))}

        <section aria-label={t(($) => $.review.activity)} className="mt-2 flex max-w-[720px] flex-col gap-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-body font-semibold">{t(($) => $.review.activity)}</h3>
            {comments.length > 0 && (
              <span className="text-caption text-muted-foreground">{t(($) => $.review.activity_count, { count: comments.length })}</span>
            )}
          </div>
          {threads.map(({ root, replies }) => (
            <CommentCard
              key={root.id}
              kbSlug={kbSlug}
              mr={mr}
              comment={root}
              replies={replies}
              pageTitle={pageTitle}
              onReply={setReplyTo}
            />
          ))}
        </section>
      </div>

      <div className="shrink-0 px-[30px] pb-5">
        <Composer
          mr={mr}
          quote={quote}
          replyTo={replyTo}
          onClearQuote={() => setQuote(null)}
          onClearReply={() => setReplyTo(null)}
          onSend={sendComment}
          sending={comment.isPending}
        />
      </div>

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
