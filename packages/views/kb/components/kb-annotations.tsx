"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { isOpenAnnotation, kbAnnotationListOptions, kbBaseDetailOptions } from "@marvis/core/kb/queries";
import { useCreateKbAnnotation, useUpdateKbAnnotationStatus } from "@marvis/core/kb/mutations";
import type { CreateKbAnnotationRequest, KbAnnotation, KbAnnotationStatus } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { kbErrorCode } from "../utils/kb-api-error";
import { useT, useTimeAgo } from "../../i18n";
import { parseKbRoute } from "../utils/kb-markdown";
import { KB_TAG } from "./kb-cite-card";
import { KbPanel } from "./kb-page-panels";
import { useCanConfigureKb } from "./kb-shell";

/** The list's tabs, in design order (5.7 / 2.3). */
const LIST_TABS: readonly KbAnnotationStatus[] = ["pending", "processing", "resolved", "dismissed"];

/** Tabs that show how many annotations they hold. */
const COUNTED_TABS: ReadonlySet<KbAnnotationStatus> = new Set(["pending", "processing"]);

const ANNOTATION_KB_LEVEL = "-";

const STATUS_DOT: Record<KbAnnotationStatus, string> = {
  pending: "bg-warning",
  processing: "bg-info",
  resolved: "bg-success",
  dismissed: "bg-faint-foreground",
};

const API_CODE_QUOTE_NOT_FOUND = "quote_not_found";


/**
 * Whether the viewer may dismiss or reopen an annotation: its author, the
 * knowledge base creator, or an owner / admin (the server checks the same).
 */
function useCanChangeAnnotation(createdBy: string | undefined) {
  const userId = useAuthStore((state) => state.user?.id ?? "");
  const canManage = useCanConfigureKb(createdBy);
  return (annotation: KbAnnotation) =>
    canManage || (annotation.author_type === "member" && !!userId && annotation.author_id === userId);
}

/** Where an annotation sits, as its location tag reads. */
function useAnnotationWhere() {
  const { t } = useT("kb");
  return (annotation: KbAnnotation) => {
    if (!annotation.page_id) return t(($) => $.annotation.where_kb);
    const title = annotation.page_title || annotation.page_path;
    if (annotation.block_id && annotation.block_index > 0) {
      return t(($) => $.annotation.where_block, { title, n: annotation.block_index });
    }
    return t(($) => $.annotation.where_page, { title });
  };
}

function StatusTag({ status }: { status: KbAnnotationStatus }) {
  const { t } = useT("kb");
  return (
    <span className={cn(KB_TAG, "shrink-0 gap-1.5")}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {t(($) => $.annotation.status[status])}
    </span>
  );
}

/** The sentence an annotation was written on, when it changed or is gone. */
function OriginalQuote({ annotation }: { annotation: KbAnnotation }) {
  const { t } = useT("kb");
  const original = annotation.anchor_lost ? annotation.original_quote || annotation.quote : annotation.original_quote;
  if (!original) return null;
  return <div className="text-caption text-faint-foreground">{t(($) => $.annotation.original, { quote: original })}</div>;
}

function QuoteBox({ annotation }: { annotation: KbAnnotation }) {
  if (!annotation.quote || annotation.anchor_lost) return null;
  return <div className="rounded-lg bg-surface-sunken px-2.5 py-1.5 text-label text-muted-foreground">{annotation.quote}</div>;
}

/** Writes the body of a new annotation: the composer of 5.2, 5.4 and 5.6. */
export function KbAnnotationComposer({
  label,
  hint,
  pending,
  onCancel,
  onSubmit,
  className,
}: {
  label: string;
  hint?: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  className?: string;
}) {
  const { t } = useT("kb");
  const [body, setBody] = useState("");
  const submit = () => {
    if (body.trim() && !pending) onSubmit(body.trim());
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Textarea
        aria-label={label}
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex items-center gap-2">
        {hint && <span className="flex-1 text-caption text-faint-foreground">{hint}</span>}
        {!hint && <span className="flex-1" />}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t(($) => $.annotation.cancel)}
        </Button>
        <Button type="button" size="sm" disabled={!body.trim() || pending} onClick={submit}>
          {t(($) => $.annotation.submit)}
        </Button>
      </div>
    </div>
  );
}

/** Creates an annotation and reports a failure; resolves true on success. */
export function useSubmitAnnotation(kbSlug: string) {
  const { t } = useT("kb");
  const create = useCreateKbAnnotation();
  const submit = async (data: CreateKbAnnotationRequest) => {
    try {
      await create.mutateAsync({ kb: kbSlug, data });
      return true;
    } catch (error) {
      toast.error(
        kbErrorCode(error) === API_CODE_QUOTE_NOT_FOUND
          ? t(($) => $.annotation.quote_not_found)
          : t(($) => $.annotation.create_failed),
      );
      return false;
    }
  };
  return { submit, pending: create.isPending };
}

function useSetAnnotationStatus() {
  const { t } = useT("kb");
  const update = useUpdateKbAnnotationStatus();
  return {
    set: (id: string, status: "pending" | "dismissed") =>
      update.mutate({ id, status }, { onError: () => toast.error(t(($) => $.annotation.update_failed)) }),
    pending: update.isPending,
  };
}

/** One annotation in the page or knowledge base panel (5.3, 5.5). */
function PanelCard({
  annotation,
  highlighted,
  canChange,
  onJump,
}: {
  annotation: KbAnnotation;
  highlighted: boolean;
  canChange: boolean;
  onJump?: (blockId: string) => void;
}) {
  const { t } = useT("kb");
  const timeAgo = useTimeAgo();
  const status = useSetAnnotationStatus();
  const jumpable = !!onJump && !!annotation.block_id && !annotation.anchor_lost;

  return (
    <article
      aria-label={annotation.body}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border bg-card p-3",
        highlighted && "ring-[1.5px] ring-warning/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-label">
        <ActorAvatar actorType={annotation.author_type} actorId={annotation.author_id} name={annotation.author_name || undefined} size="xs" />
        <span className="min-w-0 truncate">{annotation.author_name}</span>
        <span className="shrink-0 text-faint-foreground">{timeAgo(annotation.created_at)}</span>
        <span className="flex-1" />
        {annotation.anchor_lost && <span className={cn(KB_TAG, "shrink-0")}>{t(($) => $.annotation.lost)}</span>}
        <StatusTag status={annotation.status} />
      </div>
      {jumpable ? (
        <button type="button" className="text-left" onClick={() => onJump(annotation.block_id)}>
          <QuoteBox annotation={annotation} />
        </button>
      ) : (
        <QuoteBox annotation={annotation} />
      )}
      <OriginalQuote annotation={annotation} />
      <div className="text-body whitespace-pre-wrap">{annotation.body}</div>
      {canChange && annotation.status === "pending" && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="self-end"
          disabled={status.pending}
          onClick={() => status.set(annotation.id, "dismissed")}
        >
          {t(($) => $.annotation.dismiss)}
        </Button>
      )}
    </article>
  );
}

/**
 * The open annotations of a page (`pageId`) or of the whole knowledge base
 * (no `pageId`), with "添加批注" after the last one (designs 5.3–5.6).
 */
export function KbAnnotationPanel({
  kbSlug,
  createdBy,
  pageId,
  onClose,
  onJump,
}: {
  kbSlug: string;
  createdBy: string | undefined;
  pageId?: string;
  onClose: () => void;
  onJump?: (blockId: string) => void;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const canChange = useCanChangeAnnotation(createdBy);
  const [composing, setComposing] = useState(false);
  const { submit, pending } = useSubmitAnnotation(kbSlug);
  const { data: all = [] } = useQuery(kbAnnotationListOptions(wsId, kbSlug, "all", pageId || ANNOTATION_KB_LEVEL));
  const open = all.filter(isOpenAnnotation);
  const title = pageId ? t(($) => $.annotation.page_panel) : t(($) => $.annotation.kb_panel);
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const pendingIds = open.filter((annotation) => annotation.status === "pending").map((annotation) => annotation.id);
  const pageTitle = open.find((annotation) => annotation.page_title)?.page_title ?? "";

  return (
    <KbPanel
      title={`${title} ${open.length}`}
      onClose={onClose}
      className="w-[340px]"
      actions={
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pendingIds.length === 0}
          onClick={() =>
            push(
              p.kbNewJob(kbSlug, {
                starter: "annotations",
                annotations: pendingIds,
                message: pageId
                  ? t(($) => $.job.entry.annotations_page_message, { count: pendingIds.length, title: pageTitle })
                  : t(($) => $.job.entry.annotations_kb_message, { count: pendingIds.length }),
              }),
            )
          }
        >
          {t(($) => $.annotation.hand_off)}
        </Button>
      }
    >
      <div className="flex flex-col gap-2.5">
        {open.length === 0 && !composing && (
          <p className="text-label text-muted-foreground">{t(($) => $.annotation.panel_empty)}</p>
        )}
        {open.map((annotation, index) => (
          <PanelCard
            key={annotation.id}
            annotation={annotation}
            highlighted={index === 0 && !!annotation.quote && !annotation.anchor_lost}
            canChange={canChange(annotation)}
            onJump={onJump}
          />
        ))}
        {composing ? (
          <div className="rounded-xl border bg-card p-2.5">
            <KbAnnotationComposer
              label={pageId ? t(($) => $.annotation.page_compose_label) : t(($) => $.annotation.kb_compose_label)}
              pending={pending}
              onCancel={() => setComposing(false)}
              onSubmit={(body) => {
                void submit(pageId ? { page_id: pageId, body } : { body }).then((ok) => {
                  if (ok) setComposing(false);
                });
              }}
            />
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 self-start text-muted-foreground"
            onClick={() => setComposing(true)}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t(($) => $.annotation.add)}
          </Button>
        )}
      </div>
    </KbPanel>
  );
}

/** One row of the annotation list (designs 2.3, 5.7). */
function ListRow({ annotation, kbSlug, canChange }: { annotation: KbAnnotation; kbSlug: string; canChange: boolean }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const where = useAnnotationWhere();
  const status = useSetAnnotationStatus();
  const pageHref =
    annotation.page_id &&
    `${p.kbPage(kbSlug, annotation.page_id)}${annotation.block_id && !annotation.anchor_lost ? `#${annotation.block_id}` : ""}`;

  return (
    <li className="flex items-start gap-3 border-b border-border/50 px-1 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
          <ActorAvatar actorType={annotation.author_type} actorId={annotation.author_id} name={annotation.author_name || undefined} size="xs" />
          <span className="text-foreground">{annotation.author_name}</span>
          <span className="text-faint-foreground">{timeAgo(annotation.created_at)}</span>
          {pageHref ? (
            <AppLink href={pageHref} className={cn(KB_TAG, "text-info hover:underline")}>
              {where(annotation)}
            </AppLink>
          ) : (
            <span className={KB_TAG}>{where(annotation)}</span>
          )}
          {annotation.anchor_lost ? (
            <span className={cn(KB_TAG, "gap-1.5")}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              {t(($) => $.annotation.lost)}
            </span>
          ) : (
            annotation.original_quote && (
              <span className={cn(KB_TAG, "gap-1.5")}>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
                {t(($) => $.annotation.followed)}
              </span>
            )
          )}
          {annotation.mr_number !== null && (
            <span className={KB_TAG}>{t(($) => $.annotation.mr_ref, { n: annotation.mr_number })}</span>
          )}
        </div>
        <QuoteBox annotation={annotation} />
        <OriginalQuote annotation={annotation} />
        <div className="text-body whitespace-pre-wrap">{annotation.body}</div>
      </div>
      {canChange && annotation.status === "pending" && (
        <Button type="button" variant="ghost" size="xs" disabled={status.pending} onClick={() => status.set(annotation.id, "dismissed")}>
          {t(($) => $.annotation.dismiss)}
        </Button>
      )}
      {canChange && annotation.status === "dismissed" && (
        <Button type="button" variant="ghost" size="xs" disabled={status.pending} onClick={() => status.set(annotation.id, "pending")}>
          {t(($) => $.annotation.reopen)}
        </Button>
      )}
    </li>
  );
}

/** The knowledge base's annotation list (/kb/{slug}/annotations, design 2.3). */
export function KbAnnotationsPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, push } = useNavigation();
  const { kbSlug } = parseKbRoute(pathname);
  const [tab, setTab] = useState<KbAnnotationStatus>("pending");
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: all = [], isLoading } = useQuery(kbAnnotationListOptions(wsId, kbSlug, "all"));
  const canChange = useCanChangeAnnotation(base?.created_by);

  const counts = useMemo(() => {
    const out: Record<KbAnnotationStatus, number> = { pending: 0, processing: 0, resolved: 0, dismissed: 0 };
    for (const annotation of all) out[annotation.status] += 1;
    return out;
  }, [all]);
  const rows = all.filter((annotation) => annotation.status === tab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
          <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
            {base?.name ?? kbSlug}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {t(($) => $.annotation.list_title)}
          </span>
        </nav>
      </PageHeader>

      <div className="flex items-center gap-2.5 px-6 pt-4 pb-3">
        <Tabs value={tab} onValueChange={(next) => setTab(next as KbAnnotationStatus)}>
          <TabsList>
            {LIST_TABS.map((status) => (
              <TabsTrigger key={status} value={status}>
                {t(($) => $.annotation.status[status])}
                {COUNTED_TABS.has(status) && <span className="ml-1 tabular-nums">{counts[status]}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <Button
          type="button"
          disabled={counts.pending === 0}
          onClick={() =>
            push(
              p.kbNewJob(kbSlug, {
                starter: "annotations",
                annotations: all.filter((annotation) => annotation.status === "pending").map((annotation) => annotation.id),
                message: t(($) => $.job.entry.annotations_all_message, { count: counts.pending, name: base?.name ?? kbSlug }),
              }),
            )
          }
        >
          {t(($) => $.annotation.hand_off_all, { n: counts.pending })}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6">
        {!isLoading && rows.length === 0 && (
          <p className="py-6 text-label text-muted-foreground">{t(($) => $.annotation.empty)}</p>
        )}
        <ul>
          {rows.map((annotation) => (
            <ListRow key={annotation.id} annotation={annotation} kbSlug={kbSlug} canChange={canChange(annotation)} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A sentence selected inside one block of the reading page. */
export interface KbSelectedSentence {
  blockId: string;
  quote: string;
}

/**
 * Reads the selection as a sentence of one published block: the text the
 * reader sees, without citation markers, whitespace collapsed. Selections
 * spanning blocks, or inside a draft's edits, are not sentences.
 */
export function readSelectedSentence(root: HTMLElement, selection: Selection | null): KbSelectedSentence | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const blockOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-block-id]") ?? null;
  const block = blockOf(range.startContainer);
  if (!block || block !== blockOf(range.endContainer) || !root.contains(block)) return null;
  if (block.dataset.change && block.dataset.change !== "same") return null;

  const fragment = range.cloneContents();
  fragment.querySelectorAll("a[href^='#kb-cite-']").forEach((node) => node.remove());
  const quote = (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
  const blockId = block.dataset.blockId;
  if (!quote || !blockId) return null;

  return { blockId, quote };
}

interface PlacedSentence extends KbSelectedSentence {
  top: number;
  left: number;
}

const COMPOSER_WIDTH = 400;

/**
 * Selecting a sentence on the reading page shows a "批注" button below it;
 * the button opens the composer in place (designs 5.1, 5.2). `container`
 * is the positioned, scrolling element the page renders in.
 */
export function KbSelectionAnnotator({
  container,
  kbSlug,
  pageId,
  enabled,
  onCreated,
}: {
  container: RefObject<HTMLElement | null>;
  kbSlug: string;
  pageId: string;
  enabled: boolean;
  onCreated: () => void;
}) {
  const { t } = useT("kb");
  const [placed, setPlaced] = useState<PlacedSentence | null>(null);
  const [composing, setComposing] = useState(false);
  const { submit, pending } = useSubmitAnnotation(kbSlug);

  useEffect(() => {
    const root = container.current;
    if (!root || !enabled) return;

    const onMouseUp = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-kb-annotator]")) return;
      const selection = window.getSelection();
      const sentence = readSelectedSentence(root, selection);
      if (!sentence) {
        if (!composing) setPlaced(null);
        return;
      }

      const box = root.getBoundingClientRect();
      const rect = selection?.getRangeAt(0).getBoundingClientRect?.();
      const top = (rect ? rect.bottom - box.top : 0) + root.scrollTop + 8;
      const left = Math.max(8, Math.min((rect ? rect.left - box.left : 0) + root.scrollLeft, box.width - COMPOSER_WIDTH - 8));
      setComposing(false);
      setPlaced({ ...sentence, top, left });
    };

    root.addEventListener("mouseup", onMouseUp);
    return () => root.removeEventListener("mouseup", onMouseUp);
  }, [container, enabled, composing]);

  // Another page, or switching to a draft, drops the selection.
  useEffect(() => {
    setPlaced(null);
    setComposing(false);
  }, [pageId, enabled]);

  if (!placed || !enabled) return null;

  const close = () => {
    setPlaced(null);
    setComposing(false);
  };

  return (
    <div data-kb-annotator="" className="absolute z-30" style={{ top: placed.top, left: placed.left }}>
      {composing ? (
        <div
          role="dialog"
          aria-label={t(($) => $.annotation.compose_label)}
          className="rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg"
          style={{ width: COMPOSER_WIDTH }}
        >
          <KbAnnotationComposer
            label={t(($) => $.annotation.compose_label)}
            hint={t(($) => $.annotation.compose_hint)}
            pending={pending}
            onCancel={close}
            onSubmit={(body) => {
              void submit({ page_id: pageId, block_id: placed.blockId, quote: placed.quote, body }).then((ok) => {
                if (!ok) return;
                window.getSelection()?.removeAllRanges();
                close();
                onCreated();
              });
            }}
          />
        </div>
      ) : (
        <Button type="button" size="sm" className="gap-1.5 shadow-lg" onClick={() => setComposing(true)}>
          <MessageSquare aria-hidden="true" className="size-3.5" />
          {t(($) => $.annotation.action)}
        </Button>
      )}
    </div>
  );
}
