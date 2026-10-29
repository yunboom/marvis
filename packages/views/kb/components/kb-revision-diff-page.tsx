"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbPageOptions, kbRevisionDiffOptions } from "@marvis/core/kb/queries";
import type { KbDiffHunk, KbDiffLine } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";
import { formatShortDate, pageTitle } from "./kb-page-body";
import { KbHistoryPanel } from "./kb-page-panels";
import { useCanConfigureKb } from "./kb-shell";
import { KbRevertDialog, type KbRevertTarget } from "../review/kb-revert-dialog";

const LINE_SIGN: Record<string, string> = { added: "+", deleted: "−" };

function DiffLineRow({ line }: { line: KbDiffLine }) {
  return (
    <div
      data-op={line.op}
      className={cn(
        "grid grid-cols-[3rem_1.25rem_1fr] font-mono text-label leading-6",
        line.op === "added" && "bg-success/10",
        line.op === "deleted" && "bg-destructive/8",
      )}
    >
      <span className="pr-2 text-right text-faint-foreground select-none">{line.new_line || line.old_line}</span>
      <span
        className={cn(
          "text-center select-none",
          line.op === "added" && "text-success",
          line.op === "deleted" && "text-destructive",
        )}
      >
        {LINE_SIGN[line.op] ?? ""}
      </span>
      <span className="pr-3 break-words whitespace-pre-wrap">{line.text || " "}</span>
    </div>
  );
}

function HunkCard({ hunk }: { hunk: KbDiffHunk }) {
  const added = hunk.lines.filter((l) => l.op === "added").length;
  const deleted = hunk.lines.filter((l) => l.op === "deleted").length;

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 border-b bg-surface-sunken/60 px-3 py-2">
        <span className="text-label font-medium">{hunk.heading}</span>
        <span className="ml-auto text-caption tabular-nums">
          <span className="text-success">+{added}</span> <span className="text-destructive">−{deleted}</span>
        </span>
      </div>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </div>
  );
}

/** The author line and hunk cards while the diff loads. */
function HunkSkeletons() {
  return (
    <>
      <Skeleton className="h-4 w-64 max-w-full" />
      {DIFF_SKELETON_LINES.map((lines, i) => (
        <div key={i} aria-hidden="true" className="overflow-hidden rounded-xl border">
          <div className="flex items-center gap-2 border-b bg-surface-sunken/60 px-3 py-2.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="ml-auto h-3 w-10" />
          </div>
          <div className="flex flex-col gap-2.5 px-3 py-3">
            {lines.map((width, j) => (
              <Skeleton key={j} className="h-3.5" style={{ width }} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Line widths of the loading hunk cards. */
const DIFF_SKELETON_LINES = [
  ["92%", "78%", "85%", "60%"],
  ["70%", "88%", "52%"],
] as const;

/** One revision of a page compared with the revision before it. */
export function KbRevisionDiffPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const { kbSlug, pageId, revisionId } = parseKbRoute(pathname);
  const { data: page } = useQuery(kbPageOptions(wsId, pageId, ""));
  const { data: diff, isLoading, isError } = useQuery(kbRevisionDiffOptions(wsId, pageId, revisionId));
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const canRevert = useCanConfigureKb(base?.created_by);
  const [reverting, setReverting] = useState<KbRevertTarget | null>(null);

  const revision = diff?.revision.revision_id === revisionId ? diff.revision : null;
  const title = revision
    ? revision.mr_number === null
      ? t(($) => $.history.initial)
      : `#${revision.mr_number} ${revision.mr_title}`
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {base?.name ?? kbSlug}
          </AppLink>
          <span aria-hidden="true">/</span>
          <AppLink href={p.kbPage(kbSlug, pageId)} className="shrink-0 hover:text-foreground">
            {page ? pageTitle(page) : ""}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span className="shrink-0">{t(($) => $.page.history)}</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {title}
          </span>
        </nav>
        {revision?.mr_number && canRevert && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReverting({ number: revision.mr_number ?? 0, title: revision.mr_title })}
          >
            {t(($) => $.history.revert)}
          </Button>
        )}
        <AppLink
          href={p.kbPage(kbSlug, pageId)}
          aria-label={t(($) => $.history.close)}
          className="flex size-8 items-center justify-center rounded-lg bg-surface-selected text-foreground"
        >
          <X className="size-3.5" />
        </AppLink>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto px-7 py-[22px]">
          {revision ? (
            <>
              {revision.mr_number !== null && (
                <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
                  <ActorAvatar
                    actorType={revision.author_type}
                    actorId={revision.author_id}
                    name={revision.author_name || undefined}
                    size="xs"
                  />
                  <span>{t(($) => $.history.submitted_by, { author: revision.author_name })}</span>
                  {revision.merged_by && (
                    <>
                      <ActorAvatar
                        actorType="member"
                        actorId={revision.merged_by}
                        name={revision.merged_by_name || undefined}
                        size="xs"
                      />
                      <span>
                        {t(($) => $.history.merged_by, {
                          merger: revision.merged_by_name,
                          date: formatShortDate(revision.merged_at),
                        })}
                      </span>
                    </>
                  )}
                  {revision.annotations > 0 && (
                    <span>· {t(($) => $.history.annotations, { count: revision.annotations })}</span>
                  )}
                </div>
              )}
              {diff && diff.hunks.length === 0 && (
                <p className="text-label text-muted-foreground">{t(($) => $.history.no_changes)}</p>
              )}
              {diff?.hunks.map((hunk, i) => <HunkCard key={i} hunk={hunk} />)}
            </>
          ) : isError || !isLoading ? (
            <p className="text-body text-muted-foreground">{t(($) => $.history.not_found)}</p>
          ) : (
            <HunkSkeletons />
          )}
        </div>
        <KbHistoryPanel kbSlug={kbSlug} pageId={pageId} selectedRevisionId={revisionId} />
      </div>
      <KbRevertDialog kbSlug={kbSlug} target={reverting} onClose={() => setReverting(null)} />
    </div>
  );
}
