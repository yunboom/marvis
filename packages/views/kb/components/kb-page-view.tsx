"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, Info, Link2, List, MoreHorizontal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseDetailOptions, kbPageOptions } from "@marvis/core/kb/queries";
import type { KbPage, KbPageDraft, KbSource } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { copyText } from "@marvis/ui/lib/clipboard";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";
import { sourceHref, sourceKind, type KbRawFileActions } from "./kb-cite-card";
import { KbPageBody, pageTitle } from "./kb-page-body";
import { KbHistoryPanel, KbInfoPanel, KbTocPanel } from "./kb-page-panels";
import { withDraft } from "./kb-page-tree";

type Panel = "none" | "info" | "toc" | "history";

const ICON_BUTTON =
  "flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground aria-pressed:bg-surface-selected aria-pressed:text-foreground data-popup-open:bg-surface-selected";

/** The label a draft carries in the draft switcher. */
export function useDraftLabel() {
  const { t } = useT("kb");
  return useCallback(
    (draft: KbPageDraft) => {
      const label = draft.origin.label || draft.title;
      switch (draft.origin.type) {
        case "chat":
          return t(($) => $.draft.origin.chat, { label });
        case "issue":
          return t(($) => $.draft.origin.issue, { label });
        case "kb_job":
          return t(($) => $.draft.origin.kb_job, { label });
        default:
          return draft.title || t(($) => $.draft.origin.none);
      }
    },
    [t],
  );
}

/** Banner over a page the viewer has drafts for: published / draft switch. */
export function KbDraftBar({ drafts, activeDraft }: { drafts: KbPageDraft[]; activeDraft: string }) {
  const { t } = useT("kb");
  const { pathname, replace } = useNavigation();
  const timeAgo = useTimeAgo();
  const draftLabel = useDraftLabel();
  const selected = drafts.find((d) => d.id === activeDraft) ?? drafts[0];
  if (!selected) return null;

  const show = (draftId: string) => replace(withDraft(pathname, draftId));

  return (
    <div className="mb-[18px] flex items-center gap-3 rounded-xl bg-info/5 px-3.5 py-2.5 text-label ring-1 ring-info/45 ring-inset">
      <span className="rounded-md bg-info px-1.5 text-caption leading-5 text-white">{t(($) => $.draft.label)}</span>
      <span className="min-w-0 flex-1">
        {drafts.length > 1 ? t(($) => $.draft.multi, { count: drafts.length }) : t(($) => $.draft.single)}
      </span>
      {drafts.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" aria-label={t(($) => $.draft.choose)} className="max-w-60 gap-1.5">
                <span className="min-w-0 truncate">{draftLabel(selected)}</span>
                <ChevronDown aria-hidden="true" className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-[300px]">
            <DropdownMenuRadioGroup value={selected.id} onValueChange={(value) => show(String(value))}>
              {drafts.map((draft) => (
                <DropdownMenuRadioItem key={draft.id} value={draft.id}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{draftLabel(draft)}</span>
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.draft.meta, { time: timeAgo(draft.updated_at), count: draft.changed_blocks })}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div role="group" className="flex shrink-0 rounded-lg bg-surface-sunken p-0.5">
        <button
          type="button"
          aria-pressed={!activeDraft}
          onClick={() => replace(pathname)}
          className="rounded-md px-2.5 py-0.5 text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          {t(($) => $.draft.published)}
        </button>
        <button
          type="button"
          aria-pressed={!!activeDraft}
          onClick={() => show(selected.id)}
          className="rounded-md px-2.5 py-0.5 text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          {t(($) => $.draft.draft)}
        </button>
      </div>
    </div>
  );
}

function PendingReviewBanner({ page }: { page: KbPage }) {
  const { t } = useT("kb");
  if (!page.pending_mr) return null;

  return (
    <div className="mb-[18px] flex items-center gap-2.5 rounded-xl bg-info/5 px-3.5 py-2.5 text-label">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-info" />
      <span className="flex-1">
        {t(($) => $.page.pending_mr, {
          count: Math.max(page.pending_mr_count, 1),
          title: page.pending_mr.title,
          number: page.pending_mr.number,
        })}
      </span>
    </div>
  );
}

function PageMenu({ onHistory, shareHref }: { onHistory: () => void; shareHref: string }) {
  const { t } = useT("kb");
  const { getShareableUrl } = useNavigation();

  const copyLink = () => {
    void copyText(getShareableUrl(shareHref)).then((ok) => {
      if (ok) toast.success(t(($) => $.list.link_copied));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label={t(($) => $.page.more)} className={ICON_BUTTON}>
            <MoreHorizontal className="size-4" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-[240px]">
        <DropdownMenuItem onClick={onHistory}>
          <Clock className="size-4" />
          {t(($) => $.page.history)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={copyLink}>
          <Link2 className="size-4" />
          {t(($) => $.list.copy_link)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Scrolls to the block a #<block id> fragment names and flashes it. */
function useBlockAnchor(hash: string, ready: boolean) {
  useEffect(() => {
    const blockId = hash.replace(/^#/, "");
    if (!ready || !blockId) return;

    const node = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "start" });
    node.dataset.flash = "true";
    const timer = setTimeout(() => delete node.dataset.flash, 1600);
    return () => clearTimeout(timer);
  }, [hash, ready]);
}

interface KbPageViewProps {
  /** Opens or downloads raw files cited by the page. */
  rawFileActions?: KbRawFileActions;
}

/** The reading page of one knowledge base page. */
export function KbPageView({ rawFileActions }: KbPageViewProps) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, searchParams, hash, push } = useNavigation();
  const { kbSlug, pageId } = parseKbRoute(pathname);
  const draft = searchParams.get("draft") ?? "";
  const [panel, setPanel] = useState<Panel>("none");
  const [activeHeading, setActiveHeading] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: page, isLoading, isError } = useQuery(kbPageOptions(wsId, pageId, draft));
  // A draft copy is compared with the published page.
  const { data: published } = useQuery({
    ...kbPageOptions(wsId, pageId, ""),
    enabled: !!wsId && !!pageId && !!draft && page?.draft_change === "modified",
  });
  const loaded = !!page && page.id === pageId;

  useBlockAnchor(hash, loaded);

  const togglePanel = (next: Panel) => setPanel((current) => (current === next ? "none" : next));

  const jumpTo = (blockId: string) => {
    setActiveHeading(blockId);
    const node = scroller.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    node?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  const openSource = (source: KbSource) => {
    if (source.raw && rawFileActions) {
      rawFileActions.open(source.raw);
      return;
    }
    const href = sourceHref(source, p);
    if (href) push(href);
    else if (sourceKind(source.kind) === "web" && source.openable) window.open(source.uri, "_blank", "noopener,noreferrer");
  };

  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader>
          <span className="text-body text-muted-foreground">{base?.name}</span>
        </PageHeader>
        <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
          {isError || (!isLoading && !page?.id) ? t(($) => $.page.not_found) : null}
        </div>
      </div>
    );
  }

  const title = pageTitle(page);
  // Mainline reads list the viewer's drafts; a draft read of a page the
  // draft creates has no mainline to list them from.
  const drafts = page.drafts.length > 0 ? page.drafts : draft ? [syntheticDraft(draft, page)] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {base?.name ?? kbSlug}
          </AppLink>
          {page.breadcrumb.map((crumb) => (
            <span key={crumb.id} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true">/</span>
              <AppLink href={withDraft(p.kbPage(kbSlug, crumb.id), draft)} className="truncate hover:text-foreground">
                {crumb.title}
              </AppLink>
            </span>
          ))}
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {title}
          </span>
        </nav>
        <button
          type="button"
          aria-label={t(($) => $.page.toc)}
          aria-pressed={panel === "toc"}
          onClick={() => togglePanel("toc")}
          className={ICON_BUTTON}
        >
          <List className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t(($) => $.page.info)}
          aria-pressed={panel === "info"}
          onClick={() => togglePanel("info")}
          className={ICON_BUTTON}
        >
          <Info className="size-4" />
        </button>
        <PageMenu onHistory={() => setPanel("history")} shareHref={p.kbPage(kbSlug, page.id)} />
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <article
            className={cn(
              "mx-auto w-full max-w-[760px] pb-10",
              panel === "none" ? "px-14 pt-9" : "px-8 pt-7",
            )}
          >
            <KbPageBody
              page={page}
              published={published?.id === page.id ? published : null}
              rawFileActions={rawFileActions}
              banners={
                <>
                  {drafts.length > 0 && <KbDraftBar drafts={drafts} activeDraft={draft} />}
                  <PendingReviewBanner page={page} />
                </>
              }
            />
          </article>
        </div>
        {panel === "info" && (
          <KbInfoPanel page={page} kbSlug={kbSlug} onClose={() => setPanel("none")} onOpenSource={openSource} />
        )}
        {panel === "toc" && (
          <KbTocPanel page={page} activeBlockId={activeHeading} onJump={jumpTo} onClose={() => setPanel("none")} />
        )}
        {panel === "history" && (
          <KbHistoryPanel kbSlug={kbSlug} pageId={page.id} onClose={() => setPanel("none")} />
        )}
      </div>
    </div>
  );
}

/** The draft being viewed when the page response cannot list drafts. */
function syntheticDraft(draftId: string, page: KbPage): KbPageDraft {
  return {
    id: draftId,
    title: "",
    status: "open",
    updated_at: page.updated_at,
    draft_change: page.draft_change,
    changed_blocks: page.blocks.length,
    origin: { type: "none", label: "", ref_id: "" },
  };
}
