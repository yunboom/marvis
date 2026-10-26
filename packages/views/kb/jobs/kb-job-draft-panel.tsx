"use client";

import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { useWorkspacePaths } from "@marvis/core/paths";
import type { KbDraftDiffLine, KbDraftPageChange, KbJobDetail } from "@marvis/core/types";
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
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { KB_TAG } from "../components/kb-cite-card";
import { withDraft } from "../components/kb-page-tree";
import { kbJobPanelState, type KbJobDraftView } from "./kb-job-state";

const LINE_SIGN: Record<KbDraftDiffLine["kind"], string> = { add: "+", delete: "−", context: "" };

/** Format check codes the job page words itself; others show the server's message. */
const LINT_CODES = [
  "missing_type",
  "missing_title",
  "missing_description",
  "undefined_footnote",
  "claim_without_evidence",
  "invalid_evidence_uri",
  "duplicate_slug",
  "unresolved_conflict",
  "missing_evidence_version",
  "unresolved_link",
  "orphan_page",
  "isolated_page",
] as const;

type LintCode = (typeof LINT_CODES)[number];

function isLintCode(code: string): code is LintCode {
  return (LINT_CODES as readonly string[]).includes(code);
}

type Dot = "gray" | "blue" | "green" | "amber" | "red";

const DOT_CLASS: Record<Dot, string> = {
  gray: "bg-faint-foreground",
  blue: "bg-info",
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
};

function StateDot({ dot }: { dot: Dot }) {
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[dot])} />;
}

function DiffLine({ line }: { line: KbDraftDiffLine }) {
  return (
    <div
      data-kind={line.kind}
      className={cn(
        "grid grid-cols-[2.5rem_1rem_1fr] font-mono text-caption leading-5",
        line.kind === "add" && "bg-success/10",
        line.kind === "delete" && "bg-destructive/8",
      )}
    >
      <span className="pr-1.5 text-right text-faint-foreground select-none">{line.new_line || line.old_line}</span>
      <span
        className={cn(
          "text-center select-none",
          line.kind === "add" && "text-success",
          line.kind === "delete" && "text-destructive",
        )}
      >
        {LINE_SIGN[line.kind]}
      </span>
      <span className="pr-3 break-words whitespace-pre-wrap">{line.text || " "}</span>
    </div>
  );
}

function FileCard({
  kbSlug,
  draftId,
  page,
  open,
  onToggle,
}: {
  kbSlug: string;
  draftId: string;
  page: KbDraftPageChange;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const change = page.change || "modified";

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={cn("flex items-center gap-2 bg-surface-sunken/40 px-3 py-2", open && "border-b")}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-faint-foreground transition-transform", open && "rotate-90")} />
          <span className={KB_TAG}>{t(($) => $.job.draft.change[change])}</span>
          <span className="shrink-0 text-label font-medium">{page.title || page.path}</span>
          <span className="min-w-0 truncate text-caption text-faint-foreground">{page.old_path ? `${page.old_path} → ${page.path}` : page.path}</span>
        </button>
        <span className="shrink-0 text-caption tabular-nums">
          {page.added > 0 && <span className="text-success">+{page.added}</span>}{" "}
          {page.deleted > 0 && <span className="text-destructive">−{page.deleted}</span>}
        </span>
        {change !== "deleted" && (
          <AppLink
            href={withDraft(p.kbPage(kbSlug, page.page_id), draftId)}
            className="shrink-0 text-caption text-info hover:underline"
          >
            {t(($) => $.job.draft.view_in_page)}
          </AppLink>
        )}
      </div>
      {open && page.lines.map((line, index) => <DiffLine key={index} line={line} />)}
    </div>
  );
}

function StateTag({ view, reopened, running }: { view: KbJobDraftView; reopened: boolean; running: boolean }) {
  const { t } = useT("kb");
  let dot: Dot = "gray";
  let label = t(($) => $.job.draft.state.open);
  switch (view) {
    case "nodraft":
      label = t(($) => $.job.draft.state.none);
      break;
    case "empty":
      label = t(($) => $.job.draft.state.empty);
      break;
    case "nochange":
      label = t(($) => $.job.draft.state.nochange);
      break;
    case "submitted":
      dot = "blue";
      label = t(($) => $.job.draft.state.submitted);
      break;
    case "merged":
      dot = "green";
      label = t(($) => $.job.draft.state.merged);
      break;
    case "discarded":
      label = t(($) => $.job.draft.state.discarded);
      break;
    case "changes":
      if (reopened) {
        dot = "amber";
        label = t(($) => $.job.draft.state.closed);
      } else if (running) {
        dot = "green";
      }
      break;
  }

  return (
    <span className={cn(KB_TAG, "gap-1.5")}>
      <StateDot dot={dot} />
      {label}
    </span>
  );
}

/**
 * The right side of a job page: the draft the agent links, its changes as
 * file cards, the checks, and submit / discard (designs 9.3–9.17).
 */
export function KbJobDraftPanel({
  kbSlug,
  job,
  running,
  onSendMessage,
  onSubmit,
  onDiscard,
  submitting,
  discarding,
}: {
  kbSlug: string;
  job: KbJobDetail;
  running: boolean;
  /** Sends a message into the job's conversation ("ask the agent to fix"). */
  onSendMessage: (content: string) => void;
  onSubmit: () => void;
  onDiscard: () => Promise<boolean>;
  submitting: boolean;
  discarding: boolean;
}) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const state = kbJobPanelState(job, running);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const mr = job.merge_request;
  const draftId = job.draft_id ?? "";
  const draft = job.draft;

  const allCollapsed = job.pages.length > 0 && job.pages.every((page) => collapsed.has(page.page_id));
  const toggle = (pageId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });

  let hint = "";
  switch (state.view) {
    case "changes":
      hint = running
        ? t(($) => $.job.draft.hint.busy)
        : state.lintErrors > 0
          ? t(($) => $.job.draft.hint.lint, { count: state.lintErrors })
          : state.reopened
            ? t(($) => $.job.draft.hint.closed)
            : state.hasConflicts
              ? t(($) => $.job.draft.hint.conflict)
              : t(($) => $.job.draft.hint.open);
      break;
    case "empty":
      hint = t(($) => $.job.draft.hint.running);
      break;
    case "submitted":
      hint = t(($) => $.job.draft.hint.submitted);
      break;
    case "merged":
      hint = t(($) => $.job.draft.hint.merged);
      break;
  }

  let banner: { dot: Dot; text: string; href: string; link: string } | null = null;
  if (mr && state.view === "submitted") {
    banner = {
      dot: "blue",
      text:
        mr.author_type === "agent"
          ? t(($) => $.job.draft.banner.submitted_agent, { name: mr.author_name || job.agent_name, number: mr.number })
          : t(($) => $.job.draft.banner.submitted_self, { number: mr.number }),
      href: p.kbMergeRequest(kbSlug, mr.number),
      link: t(($) => $.job.draft.banner_review),
    };
  } else if (mr && state.view === "merged") {
    banner = {
      dot: "green",
      text: t(($) => $.job.draft.banner.merged, { number: mr.number, name: mr.merged_by_name }),
      href: job.pages[0] ? p.kbPage(kbSlug, job.pages[0].page_id) : p.kbBase(kbSlug),
      link: t(($) => $.job.draft.banner_view_page),
    };
  } else if (mr && state.reopened) {
    banner = {
      dot: "amber",
      text: mr.close_reason
        ? t(($) => $.job.draft.banner.closed, { number: mr.number, name: mr.closed_by_name, reason: mr.close_reason })
        : t(($) => $.job.draft.banner.closed_no_reason, { number: mr.number, name: mr.closed_by_name }),
      href: p.kbMergeRequest(kbSlug, mr.number),
      link: t(($) => $.job.draft.banner_comments),
    };
  }

  const showFiles = state.view === "changes" || state.view === "submitted" || state.view === "merged";
  const checks = (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-sunken/60 px-3 py-2.5">
      <span className="text-caption text-faint-foreground">{t(($) => $.job.draft.checks)}</span>
      {running && state.view === "changes" ? (
        <span className="flex items-center gap-1.5 text-label">
          <StateDot dot="gray" />
          {t(($) => $.job.draft.checks_pending)}
        </span>
      ) : (
        <>
          {job.checks.lint.map((finding, index) => (
            <span key={`lint-${index}`} className="flex items-start gap-1.5 text-label">
              <span className="mt-1.5">
                <StateDot dot={finding.severity === "error" ? "red" : "amber"} />
              </span>
              <span className="min-w-0 flex-1 break-words">
                {finding.path} · {isLintCode(finding.code) ? t(($) => $.job.draft.lint[finding.code as LintCode]) : finding.message}
              </span>
            </span>
          ))}
          {job.checks.conflicts.map((conflict, index) => (
            <span key={`conflict-${index}`} className="flex items-start gap-1.5 text-label">
              <span className="mt-1.5">
                <StateDot dot="amber" />
              </span>
              <span className="min-w-0 flex-1 break-words">{t(($) => $.job.draft.conflict, { path: conflict.path })}</span>
            </span>
          ))}
          {job.checks.lint.length === 0 && job.checks.conflicts.length === 0 && (
            <span className="flex items-center gap-1.5 text-label">
              <StateDot dot="green" />
              {t(($) => $.job.draft.lint_ok)}
            </span>
          )}
        </>
      )}
      {state.view === "changes" && !running && (state.lintErrors > 0 || state.hasConflicts) && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="self-start"
          onClick={() =>
            onSendMessage(
              state.lintErrors > 0
                ? t(($) => $.job.draft.fix_message, { draft: draftId })
                : t(($) => $.job.draft.rebase_message, { draft: draftId }),
            )
          }
        >
          {state.lintErrors > 0 ? t(($) => $.job.draft.fix) : t(($) => $.job.draft.rebase)}
        </Button>
      )}
    </div>
  );

  return (
    <section
      aria-label={t(($) => $.job.draft.title)}
      className="flex min-h-0 w-[560px] max-w-[48%] shrink-0 flex-col border-l bg-surface-sunken/20 max-lg:max-h-[50%] max-lg:w-full max-lg:max-w-none max-lg:border-t max-lg:border-l-0"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-title font-semibold">{t(($) => $.job.draft.title)}</h2>
          <StateTag view={state.view} reopened={state.reopened} running={running} />
        </div>

        {state.view === "nodraft" && (
          <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.job.draft.nodraft)}</p>
        )}
        {state.view === "empty" && (
          <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.job.draft.empty)}</p>
        )}
        {state.view === "nochange" && (
          <div className="flex flex-col items-center gap-1.5 py-10 text-center">
            <span className="text-body font-medium">{t(($) => $.job.draft.nochange_title)}</span>
            <span className="text-caption text-faint-foreground">{t(($) => $.job.draft.nochange_hint)}</span>
          </div>
        )}
        {state.view === "discarded" && (
          <p className="py-10 text-center text-body text-muted-foreground">{t(($) => $.job.draft.discarded)}</p>
        )}

        {showFiles && (
          <>
            {banner && (
              <div
                role="status"
                className={cn(
                  "flex items-center gap-2 rounded-xl px-3 py-2.5 text-label",
                  banner.dot === "blue" && "bg-info/10",
                  banner.dot === "green" && "bg-success/10",
                  banner.dot === "amber" && "bg-warning/10",
                )}
              >
                <StateDot dot={banner.dot} />
                <span className="min-w-0 flex-1">{banner.text}</span>
                <AppLink href={banner.href} className="shrink-0 text-info hover:underline">
                  {banner.link}
                </AppLink>
              </div>
            )}
            <div className="flex items-center">
              <span className="flex-1 text-caption text-faint-foreground">
                {t(($) => $.job.draft.summary, { count: job.pages.length, added: draft?.added ?? 0, deleted: draft?.deleted ?? 0 })}
              </span>
              <button
                type="button"
                className="text-caption text-info hover:underline"
                onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(job.pages.map((page) => page.page_id)))}
              >
                {allCollapsed ? t(($) => $.job.draft.expand_all) : t(($) => $.job.draft.collapse_all)}
              </button>
            </div>
            {job.pages.map((page) => (
              <FileCard
                key={page.page_id}
                kbSlug={kbSlug}
                draftId={draftId}
                page={page}
                open={!collapsed.has(page.page_id)}
                onToggle={() => toggle(page.page_id)}
              />
            ))}
            {checks}
          </>
        )}
      </div>

      {(hint || state.showSubmit || state.canDiscard || state.view === "submitted") && (
        <div className="flex items-center gap-2 border-t pt-3.5 pr-20 pb-4 pl-6">
          <span className="min-w-0 flex-1 text-caption text-faint-foreground">{hint}</span>
          {state.canDiscard && (
            <Button type="button" variant="ghost" disabled={discarding || submitting} onClick={() => setConfirmingDiscard(true)}>
              {t(($) => $.job.draft.discard)}
            </Button>
          )}
          {state.showSubmit && (
            <Button type="button" disabled={!state.canSubmit || submitting} onClick={onSubmit}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {state.reopened ? t(($) => $.job.draft.resubmit) : t(($) => $.job.draft.submit)}
            </Button>
          )}
          {state.view === "submitted" && mr && (
            <Button render={<AppLink href={p.kbMergeRequest(kbSlug, mr.number)} />} nativeButton={false}>
              {t(($) => $.job.draft.go_review, { number: mr.number })}
            </Button>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmingDiscard}
        onOpenChange={(open) => {
          if (!open && !discarding) setConfirmingDiscard(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.job.draft.discard_confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.job.draft.discard_confirm_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discarding}>{t(($) => $.job.draft.keep)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={discarding}
              onClick={(event) => {
                event.preventDefault();
                void onDiscard().then((ok) => {
                  if (ok) setConfirmingDiscard(false);
                });
              }}
            >
              {discarding && <Loader2 className="size-4 animate-spin" />}
              {t(($) => $.job.draft.discard)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
