"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Clock, Info, Link2, List, MessageSquare, MoreHorizontal, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import {
  isOpenAnnotation,
  kbAnnotationListOptions,
  kbBaseDetailOptions,
  kbPageOptions,
} from "@marvis/core/kb/queries";
import type { KbAnnotation, KbBlock, KbPage, KbPageDraft, KbSource } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Switch } from "@marvis/ui/components/ui/switch";
import { Toggle } from "@marvis/ui/components/ui/toggle";
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
import { KbAnnotationPanel, KbSelectionAnnotator } from "./kb-annotations";
import { KbHistoryPanel, KbInfoPanel, KbTocPanel } from "./kb-page-panels";
import { readsDraftDiff, withDraft } from "./kb-page-tree";
import { useKbRawFilePreview } from "../manage/use-kb-raw-files";

type Panel = "none" | "info" | "toc" | "history" | "annotations";

// Header panel toggles share the reading page's muted icon look.
const PANEL_TOGGLE = "text-muted-foreground aria-pressed:bg-surface-selected aria-pressed:text-foreground";

// The draft change of a page the draft creates: it has no official version.
const DRAFT_ADDED = "added";

const NO_BLOCKS: readonly KbBlock[] = [];

// One side of the official / draft segmented switch.
const SEGMENT =
  "h-6 px-2.5 font-normal text-muted-foreground hover:bg-transparent aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm";

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

/**
 * Banner over a page the viewer has drafts for: official / draft switch, and
 * on a draft read a switch that marks its edits. A page the draft creates has
 * no official version to switch to.
 */
export function KbDraftBar({
  drafts,
  activeDraft,
  diff = true,
  pageDraftChange = "",
}: {
  drafts: KbPageDraft[];
  activeDraft: string;
  /** The draft's edits are marked on the page. */
  diff?: boolean;
  /** The draft change of the page as read through `activeDraft`. */
  pageDraftChange?: string;
}) {
  const { t } = useT("kb");
  const { pathname, replace } = useNavigation();
  const timeAgo = useTimeAgo();
  const draftLabel = useDraftLabel();
  const diffLabel = useId();
  const selected = drafts.find((d) => d.id === activeDraft) ?? drafts[0];
  if (!selected) return null;

  const added = (activeDraft ? pageDraftChange : selected.draft_change) === DRAFT_ADDED;

  return (
    <div className="mb-[18px] flex items-center gap-3 rounded-xl bg-status-review/5 px-3.5 py-2.5 text-label ring-1 ring-status-review/45 ring-inset">
      <span className="rounded-md bg-status-review px-1.5 text-caption leading-5 text-primary-foreground">{t(($) => $.draft.label)}</span>
      <span className="min-w-0 flex-1">
        {!added && (drafts.length > 1 ? t(($) => $.draft.multi, { count: drafts.length }) : t(($) => $.draft.single))}
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
            <DropdownMenuRadioGroup
              value={selected.id}
              onValueChange={(value) => replace(withDraft(pathname, String(value), !activeDraft || diff))}
            >
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
      {!added && (
        <div role="group" className="flex shrink-0 rounded-lg bg-surface-sunken p-0.5">
          <Toggle size="sm" pressed={!activeDraft} onPressedChange={() => replace(pathname)} className={SEGMENT}>
            {t(($) => $.draft.official)}
          </Toggle>
          <Toggle size="sm" pressed={!!activeDraft} onPressedChange={() => replace(withDraft(pathname, selected.id))} className={SEGMENT}>
            {t(($) => $.draft.draft)}
          </Toggle>
        </div>
      )}
      {activeDraft && (
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <Switch
            size="sm"
            aria-labelledby={diffLabel}
            checked={diff}
            onCheckedChange={(checked: boolean) => replace(withDraft(pathname, activeDraft, checked))}
          />
          <span id={diffLabel}>{t(($) => $.draft.show_diff)}</span>
        </label>
      )}
    </div>
  );
}

function PendingReviewBanner({ kbSlug, page }: { kbSlug: string; page: KbPage }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
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
      <AppLink href={p.kbMergeRequest(kbSlug, page.pending_mr.number)} className="shrink-0 text-info hover:underline">
        {t(($) => $.page.view_change)}
      </AppLink>
    </div>
  );
}

function PageMenu({ onHistory, onCheck, shareHref }: { onHistory: () => void; onCheck?: () => void; shareHref: string }) {
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
          <Button variant="ghost" size="icon-sm" aria-label={t(($) => $.page.more)} className="text-muted-foreground data-popup-open:bg-surface-selected">
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-[240px]">
        <DropdownMenuItem onClick={onHistory}>
          <Clock className="size-4" />
          {t(($) => $.page.history)}
        </DropdownMenuItem>
        {onCheck && (
          <DropdownMenuItem onClick={onCheck}>
            <ShieldCheck className="size-4" />
            {t(($) => $.job.entry.check_page)}
          </DropdownMenuItem>
        )}
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
export function KbPageView({ rawFileActions: rawFileActionsProp }: KbPageViewProps) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, searchParams, hash, push } = useNavigation();
  const { kbSlug, pageId } = parseKbRoute(pathname);
  const rawPreview = useKbRawFilePreview(kbSlug);
  const rawFileActions = rawFileActionsProp ?? rawPreview.actions;
  const draft = searchParams.get("draft") ?? "";
  const diff = readsDraftDiff(searchParams);
  const [panel, setPanel] = useState<Panel>("none");
  const [activeHeading, setActiveHeading] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: page, isLoading, isError, error } = useQuery(kbPageOptions(wsId, pageId, draft));
  // Someone else's draft the reader may not see stays an error, not the published page.
  const draftForbidden = !!draft && error instanceof ApiError && error.status === 403;
  // Marking a draft's edits compares it with the official page, which a page
  // the draft creates does not have.
  const added = page?.draft_change === DRAFT_ADDED;
  const { data: published } = useQuery({
    ...kbPageOptions(wsId, pageId, ""),
    enabled: !!wsId && !!pageId && diff && !!page?.draft_change && !added,
  });
  const loaded = !!page && page.id === pageId;
  // Annotated sentences are marked while the annotation panel is open.
  const { data: annotations = [] } = useQuery({
    ...kbAnnotationListOptions(wsId, kbSlug, "all", pageId),
    enabled: !!wsId && !!kbSlug && !!pageId && panel === "annotations",
  });

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
          {draftForbidden
            ? t(($) => $.page.draft_forbidden)
            : isError || (!isLoading && !page?.id)
              ? t(($) => $.page.not_found)
              : null}
        </div>
      </div>
    );
  }

  const title = pageTitle(page);
  // With edits marked, a page the draft creates is all new, and a draft that
  // leaves the page alone compares with itself.
  const diffBase = !diff
    ? undefined
    : added
      ? NO_BLOCKS
      : !page.draft_change
        ? page.blocks
        : published?.id === page.id
          ? published.blocks
          : undefined;
  // Mainline reads list the viewer's drafts; a draft read of a page the
  // draft creates has no mainline to list them from.
  const drafts = page.drafts.length > 0 ? page.drafts : draft ? [syntheticDraft(draft, page)] : [];
  const banners = (
    <>
      {drafts.length > 0 && (
        <KbDraftBar drafts={drafts} activeDraft={draft} diff={diff} pageDraftChange={page.draft_change} />
      )}
      <PendingReviewBanner kbSlug={kbSlug} page={page} />
    </>
  );

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
              <AppLink href={withDraft(p.kbPage(kbSlug, crumb.id), draft, diff)} className="truncate hover:text-foreground">
                {crumb.title}
              </AppLink>
            </span>
          ))}
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {title}
          </span>
        </nav>
        <Toggle
          aria-label={t(($) => $.annotation.page_panel)}
          pressed={panel === "annotations"}
          onPressedChange={() => togglePanel("annotations")}
          className={PANEL_TOGGLE}
        >
          <MessageSquare className="size-4" />
          {page.annotations_open > 0 && <span className="text-label tabular-nums">{page.annotations_open}</span>}
        </Toggle>
        <Toggle
          aria-label={t(($) => $.page.toc)}
          pressed={panel === "toc"}
          onPressedChange={() => togglePanel("toc")}
          className={PANEL_TOGGLE}
        >
          <List className="size-4" />
        </Toggle>
        <Toggle
          aria-label={t(($) => $.page.info)}
          pressed={panel === "info"}
          onPressedChange={() => togglePanel("info")}
          className={PANEL_TOGGLE}
        >
          <Info className="size-4" />
        </Toggle>
        <PageMenu
          onHistory={() => setPanel("history")}
          onCheck={
            draft
              ? undefined
              : () =>
                  push(
                    p.kbNewJob(kbSlug, {
                      starter: "health",
                      page: page.id,
                      message: t(($) => $.job.entry.check_page_message, { title }),
                    }),
                  )
          }
          shareHref={p.kbPage(kbSlug, page.id)}
        />
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-y-auto">
          <article
            className={cn(
              // The body fills the width beside any panel; the text column, with
              // the title and banners, stops at 1080px (1176 - 2*48) and centers.
              "mx-auto w-full max-w-[1176px] px-12 pb-10",
              panel === "none" ? "pt-9" : "pt-7",
            )}
          >
            <KbPageBody
              page={page}
              diffBase={diffBase}
              rawFileActions={rawFileActions}
              onRawLink={rawPreview.openLinked}
              annotatedQuotes={panel === "annotations" ? annotatedQuotes(annotations) : undefined}
              kbSlug={kbSlug}
              draft={draft}
              diff={diff}
              banners={banners}
            />
          </article>
          <KbSelectionAnnotator
            container={scroller}
            kbSlug={kbSlug}
            pageId={page.id}
            enabled={!draft}
            onCreated={() => setPanel("annotations")}
          />
        </div>
        {panel === "annotations" && (
          <KbAnnotationPanel
            kbSlug={kbSlug}
            createdBy={base?.created_by}
            pageId={page.id}
            onJump={jumpTo}
            onClose={() => setPanel("none")}
          />
        )}
        {panel === "info" && (
          <KbInfoPanel page={page} kbSlug={kbSlug} draft={draft} onClose={() => setPanel("none")} onOpenSource={openSource} />
        )}
        {panel === "toc" && (
          <KbTocPanel page={page} activeBlockId={activeHeading} onJump={jumpTo} onClose={() => setPanel("none")} />
        )}
        {panel === "history" && (
          <KbHistoryPanel kbSlug={kbSlug} pageId={page.id} onClose={() => setPanel("none")} />
        )}
      </div>
      {rawPreview.modal}
    </div>
  );
}

/** The sentences of open annotations, by block, to mark on the page. */
function annotatedQuotes(annotations: readonly KbAnnotation[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const annotation of annotations) {
    if (!isOpenAnnotation(annotation) || !annotation.block_id || !annotation.quote) continue;
    out.set(annotation.block_id, [...(out.get(annotation.block_id) ?? []), annotation.quote]);
  }
  return out;
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
