"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { KbDraftDiffLine, KbDraftPageChange, KbLintFinding } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { KB_TAG } from "./kb-cite-card";

const LINE_SIGN: Record<KbDraftDiffLine["kind"], string> = { add: "+", delete: "−", context: "" };

/** Format check codes the pages word themselves; others show the server's message. */
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

/** A format check finding, worded by its code. */
export function useLintText(): (finding: KbLintFinding) => string {
  const { t } = useT("kb");

  return (finding) =>
    `${finding.path} · ${isLintCode(finding.code) ? t(($) => $.job.draft.lint[finding.code as LintCode]) : finding.message}`;
}

export type KbDot = "gray" | "blue" | "green" | "amber" | "red";

const DOT_CLASS: Record<KbDot, string> = {
  gray: "bg-faint-foreground",
  blue: "bg-info",
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
};

export function KbStateDot({ dot }: { dot: KbDot }) {
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[dot])} />;
}

function DiffLine({
  line,
  selected,
  onSelect,
  action,
}: {
  line: KbDraftDiffLine;
  selected: boolean;
  onSelect?: () => void;
  action?: ReactNode;
}) {
  const content = (
    <>
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
      <span className={cn("pr-3 break-words whitespace-pre-wrap", selected && "rounded-sm bg-info/15")}>{line.text || " "}</span>
    </>
  );
  const rowClass = cn(
    "relative grid w-full grid-cols-[2.5rem_1rem_1fr] text-left font-mono text-caption leading-5",
    line.kind === "add" && "bg-success/10",
    line.kind === "delete" && "bg-destructive/8",
  );

  if (!onSelect) {
    return (
      <div data-kind={line.kind} className={rowClass}>
        {content}
      </div>
    );
  }

  return (
    <div data-kind={line.kind} className="relative">
      <button type="button" aria-pressed={selected} onClick={onSelect} className={cn(rowClass, "cursor-pointer hover:bg-surface-hover")}>
        {content}
      </button>
      {selected && action && <div className="absolute -top-8 left-24 z-10">{action}</div>}
    </div>
  );
}

/**
 * A changed page as a collapsible GitLab-style file card: change tag, title,
 * path, line counts and its diff lines. Lines become selectable when the
 * card offers an action on the selected line (review "add comment").
 */
export function KbFileCard({
  page,
  open,
  onToggle,
  href,
  selectedLine = -1,
  onSelectLine,
  lineAction,
}: {
  page: KbDraftPageChange;
  open: boolean;
  onToggle: () => void;
  /** Opens the page; left out for deleted pages. */
  href?: string;
  selectedLine?: number;
  onSelectLine?: (index: number) => void;
  lineAction?: ReactNode;
}) {
  const { t } = useT("kb");
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
        {change !== "deleted" && href && (
          <AppLink href={href} className="shrink-0 text-caption text-info hover:underline">
            {t(($) => $.job.draft.view_in_page)}
          </AppLink>
        )}
      </div>
      {open &&
        page.lines.map((line, index) => (
          <DiffLine
            key={index}
            line={line}
            selected={index === selectedLine}
            onSelect={onSelectLine && line.block_id ? () => onSelectLine(index) : undefined}
            action={lineAction}
          />
        ))}
    </div>
  );
}
