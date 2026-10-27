"use client";

import { FileText } from "lucide-react";
import { useWorkspacePaths } from "@marvis/core/paths";
import { useActorName } from "@marvis/core/workspace/hooks";
import type { KbRawFile, KbSource } from "@marvis/core/types";
import { Button, buttonVariants } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

const SOURCE_KINDS = ["task", "chat", "pr", "repo", "raw", "web", "other"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

/** A source kind the UI knows, "other" for anything newer. */
export function sourceKind(kind: string): SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(kind) ? (kind as SourceKind) : "other";
}

/** Opens or downloads the raw file behind a raw:// source. */
export interface KbRawFileActions {
  open: (file: KbRawFile) => void;
  download: (file: KbRawFile) => void;
}

/** In-app destination of a source, when it has one. */
export function sourceHref(source: KbSource, paths: ReturnType<typeof useWorkspacePaths>): string | null {
  if (!source.openable) return null;

  const [, rest = ""] = source.uri.split("://");
  switch (sourceKind(source.kind)) {
    case "task":
      return rest ? paths.issueDetail(rest) : null;
    case "chat":
      return rest ? paths.chatSession(rest) : null;
    default:
      return null;
  }
}

/** repo://path#L40-L82 → path and line range. */
function repoLocation(uri: string): { path: string; from: string; to: string } {
  const [rest = ""] = uri.replace(/^repo:\/\//, "").split("@");
  const [path = "", anchor = ""] = rest.split("#");
  const match = /^L(\d+)(?:-L(\d+))?$/.exec(anchor);
  return { path, from: match?.[1] ?? "", to: match?.[2] ?? match?.[1] ?? "" };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export const KB_TAG =
  "inline-flex h-5 shrink-0 items-center rounded-md bg-surface-sunken px-1.5 text-caption text-muted-foreground";

/** What a citation shows on hover: where the claim came from and how to open it. */
export function KbCiteCard({ source, rawFileActions }: { source: KbSource; rawFileActions?: KbRawFileActions }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const { getMemberName } = useActorName();
  const kind = sourceKind(source.kind);
  const href = sourceHref(source, p);

  if (kind === "raw") {
    const raw = source.raw;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={KB_TAG}>{t(($) => $.cite.kind.raw)}</span>
          {raw && (
            <span className="text-caption text-faint-foreground">
              {t(($) => $.cite.uploaded, { name: getMemberName(raw.uploaded_by), date: formatDate(raw.created_at) })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-label font-medium">{raw?.name ?? source.title}</span>
        </div>
        <div className="text-label text-muted-foreground">
          {raw && raw.page > 0 ? `${t(($) => $.cite.page, { page: raw.page })} · ${source.title}` : source.title}
        </div>
        {raw ? (
          rawFileActions && (
            <div className="flex gap-2 pt-0.5">
              <Button size="sm" variant="outline" onClick={() => rawFileActions.open(raw)}>
                {t(($) => $.cite.open_file)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => rawFileActions.download(raw)}>
                {t(($) => $.cite.download)}
              </Button>
            </div>
          )
        ) : (
          <div className="text-label text-faint-foreground">{t(($) => $.cite.file_missing)}</div>
        )}
      </div>
    );
  }

  if (kind === "repo") {
    const location = repoLocation(source.uri);
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={KB_TAG}>{t(($) => $.cite.kind.repo)}</span>
          {source.version && (
            <span className="text-caption text-faint-foreground">
              {t(($) => $.cite.checked_at, { version: source.version })}
            </span>
          )}
        </div>
        <div className="font-mono text-label break-all">{location.path}</div>
        {location.from && (
          <div className="text-label text-muted-foreground">
            {t(($) => $.cite.lines, { from: location.from, to: location.to })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className={KB_TAG + " self-start"}>{t(($) => $.cite.kind[kind])}</span>
      {kind === "chat" && !source.openable ? (
        <div className="text-label text-muted-foreground">{t(($) => $.cite.chat_private)}</div>
      ) : (
        <div className="text-label">{source.title || source.uri}</div>
      )}
      {href && (
        <AppLink href={href} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}>
          {kind === "chat" ? t(($) => $.cite.open_chat) : t(($) => $.cite.open_issue)}
        </AppLink>
      )}
      {kind === "web" && (
        <a
          href={source.uri}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}
        >
          {t(($) => $.cite.open_link)}
        </a>
      )}
    </div>
  );
}
