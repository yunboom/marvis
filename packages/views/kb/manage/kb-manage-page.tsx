"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { FileText, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useDeleteKnowledgeBase, useUploadKbRawFiles } from "@marvis/core/kb/mutations";
import { kbBaseDetailOptions, kbRawFileListOptions } from "@marvis/core/kb/queries";
import { useWorkspacePaths, type KbManageTab } from "@marvis/core/paths";
import type { KbRawFileItem, KnowledgeBaseDetail } from "@marvis/core/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button, buttonVariants } from "@marvis/ui/components/ui/button";
import { Checkbox } from "@marvis/ui/components/ui/checkbox";
import { Input } from "@marvis/ui/components/ui/input";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useCanConfigureKb } from "../components/kb-shell";
import { formatShortDate } from "../components/kb-page-body";
import { kbErrorCode } from "../utils/kb-api-error";
import { parseKbManageRoute } from "./kb-manage-route";
import { clickDownloadAnchor, rawFileFromItem, useKbRawFilePreview } from "./use-kb-raw-files";

const API_CODE_RAW_NAME_TAKEN = "raw_name_taken";
const API_CODE_RAW_NAME_INVALID = "raw_name_invalid";

/** The OKF specification the export follows (design 11.2). */
const OKF_SPEC_URL = "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md";

/** Breadcrumb of the knowledge base's own full pages: Knowledge base / name / title. */
export function KbPageCrumb({ kbSlug, name, title }: { kbSlug: string; name: string; title: string }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();

  return (
    <nav aria-label={t(($) => $.nav.breadcrumb)} className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
      <AppLink href={p.kb()} className="shrink-0 hover:text-foreground">
        {t(($) => $.list.title)}
      </AppLink>
      <span aria-hidden="true">/</span>
      <AppLink href={p.kbBase(kbSlug)} className="shrink-0 hover:text-foreground">
        {name}
      </AppLink>
      <span aria-hidden="true">/</span>
      <span aria-current="page" className="truncate font-medium text-foreground">
        {title}
      </span>
    </nav>
  );
}

function takenNames(error: unknown): string {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return "";
  const names = (error.body as Record<string, unknown>).names;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string").join("、") : "";
}

/** Raw files (design 11.1): upload, preview every row, hand selected files to an ingest job. */
function RawFilesSection({ kbSlug }: { kbSlug: string }) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const { data: files = [], isLoading } = useQuery(kbRawFileListOptions(wsId, kbSlug));
  const upload = useUploadKbRawFiles();
  const preview = useKbRawFilePreview(kbSlug);
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const chosen = files.filter((file) => selected.has(file.id));
  const allChosen = files.length > 0 && chosen.length === files.length;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (list.length === 0) return;

    upload.mutate(
      { kb: kbSlug, files: list },
      {
        // New files come selected, ready to hand to an agent.
        onSuccess: (written) => {
          toast.success(t(($) => $.manage.raw.uploaded, { count: written.length }));
          setSelected(new Set(written.map((file) => file.id)));
        },
        onError: (error) => {
          const code = kbErrorCode(error);
          if (code === API_CODE_RAW_NAME_TAKEN) toast.error(t(($) => $.manage.raw.name_taken, { names: takenNames(error) }));
          else if (code === API_CODE_RAW_NAME_INVALID) toast.error(t(($) => $.manage.raw.name_invalid));
          else toast.error(t(($) => $.manage.raw.upload_failed));
        },
      },
    );
  };

  const ingest = () => push(p.kbNewJob(kbSlug, { starter: "ingest", sources: chosen.map((file) => file.uri) }));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <h2 className="flex-1 text-title font-semibold">{t(($) => $.manage.raw.title)}</h2>
        {chosen.length > 0 && (
          <Button type="button" variant="outline" onClick={ingest}>
            {t(($) => $.manage.raw.ingest_count, { count: chosen.length })}
          </Button>
        )}
        <Button type="button" disabled={upload.isPending} onClick={() => input.current?.click()}>
          {upload.isPending && <Loader2 className="size-4 animate-spin" />}
          {upload.isPending ? t(($) => $.manage.raw.uploading) : t(($) => $.manage.raw.upload)}
        </Button>
        <input ref={input} type="file" multiple hidden onChange={onFiles} data-testid="kb-raw-input" />
      </div>
      <p className="text-label text-muted-foreground">{t(($) => $.manage.raw.description)}</p>

      <div role="table" aria-label={t(($) => $.manage.raw.title)}>
        <div
          role="row"
          className="grid h-9 grid-cols-[28px_2.4fr_1.4fr_1fr_1fr] items-center rounded-[10px] bg-surface-sunken px-2.5 text-caption text-muted-foreground"
        >
          <span role="columnheader">
            <Checkbox
              aria-label={t(($) => $.manage.raw.select_all)}
              checked={allChosen}
              indeterminate={chosen.length > 0 && !allChosen}
              disabled={files.length === 0}
              onCheckedChange={(on) => setSelected(on ? new Set(files.map((file) => file.id)) : new Set())}
            />
          </span>
          <span role="columnheader">{t(($) => $.manage.raw.col.name)}</span>
          <span role="columnheader">{t(($) => $.manage.raw.col.source)}</span>
          <span role="columnheader">{t(($) => $.manage.raw.col.created)}</span>
          <span role="columnheader">{t(($) => $.manage.raw.col.cited)}</span>
        </div>
        {!isLoading && files.length === 0 && (
          <p className="px-2.5 py-6 text-label text-muted-foreground">{t(($) => $.manage.raw.empty)}</p>
        )}
        {files.map((file) => (
          <RawFileRow
            key={file.id}
            file={file}
            checked={selected.has(file.id)}
            onCheck={(on) => toggle(file.id, on)}
            onOpen={() => preview.actions.open(rawFileFromItem(file))}
          />
        ))}
      </div>
      {preview.modal}
    </section>
  );
}

function RawFileRow({
  file,
  checked,
  onCheck,
  onOpen,
}: {
  file: KbRawFileItem;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useT("kb");

  return (
    <div role="row" className="grid grid-cols-[28px_2.4fr_1.4fr_1fr_1fr] items-center border-b px-2.5 py-3 text-label">
      <span role="cell">
        <Checkbox aria-label={t(($) => $.manage.raw.select, { name: file.name })} checked={checked} onCheckedChange={onCheck} />
      </span>
      <span role="cell" className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t(($) => $.manage.raw.open, { name: file.name })}
          className="flex max-w-full items-center gap-2 text-left hover:underline"
        >
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{file.name}</span>
        </button>
      </span>
      <span role="cell" className="truncate text-muted-foreground">
        {t(($) => $.manage.raw.source_upload, { name: file.uploaded_by_name })}
      </span>
      <span role="cell" className="text-muted-foreground">
        {formatShortDate(file.created_at)}
      </span>
      <span role="cell" className="text-muted-foreground">
        {file.cited_pages > 0 ? t(($) => $.manage.raw.cited, { count: file.cited_pages }) : "—"}
      </span>
    </div>
  );
}

/** Export (design 11.2): the OKF bundle as a zip. */
function ExportSection({ kbSlug }: { kbSlug: string }) {
  const { t } = useT("kb");
  const [exporting, setExporting] = useState(false);

  const exportZip = () => {
    setExporting(true);
    void api
      .exportKnowledgeBase(kbSlug)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        clickDownloadAnchor(url, `${kbSlug}.zip`);
        // Let the click start the download before the URL goes away.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
      .catch(() => toast.error(t(($) => $.manage.export.failed)))
      .finally(() => setExporting(false));
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-title font-semibold">{t(($) => $.manage.export.title)}</h2>
      <div className="flex items-center gap-3.5 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="font-medium">{t(($) => $.manage.export.okf)}</div>
          <div className="text-label text-faint-foreground">{t(($) => $.manage.export.okf_description)}</div>
          <a href={OKF_SPEC_URL} target="_blank" rel="noopener noreferrer" className="self-start text-caption text-brand hover:underline">
            {t(($) => $.manage.export.spec_link)}
          </a>
        </div>
        <Button type="button" variant="outline" disabled={exporting} onClick={exportZip}>
          {exporting && <Loader2 className="size-4 animate-spin" />}
          {exporting ? t(($) => $.manage.export.exporting) : t(($) => $.manage.export.button)}
        </Button>
      </div>
    </section>
  );
}

/** Confirms deleting a knowledge base by typing its name (design 11.3). */
export function KbDeleteDialog({ base, open, onClose }: { base: KnowledgeBaseDetail; open: boolean; onClose: () => void }) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const remove = useDeleteKnowledgeBase();
  const [name, setName] = useState("");

  const submit = () => {
    remove.mutate(
      { kb: base.slug, confirmName: name },
      {
        onSuccess: () => {
          onClose();
          toast.success(t(($) => $.manage.delete.deleted, { name: base.name }));
          push(p.kb());
        },
        onError: () => toast.error(t(($) => $.manage.delete.failed)),
      },
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !remove.isPending) {
          setName("");
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.manage.delete.dialog_title, { name: base.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.manage.delete.dialog_body, {
              slug: base.slug,
              annotations: base.pending.annotations,
              mrs: base.pending.open_mrs,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex flex-col gap-1.5 text-label">
          <span className="text-muted-foreground">{t(($) => $.manage.delete.confirm_label)}</span>
          <Input
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name === base.name && !remove.isPending) submit();
            }}
          />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>{t(($) => $.manage.delete.cancel)}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={name !== base.name || remove.isPending} onClick={submit}>
            {remove.isPending && <Loader2 className="size-4 animate-spin" />}
            {remove.isPending ? t(($) => $.manage.delete.deleting) : t(($) => $.manage.delete.confirm)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteSection({ base, canDelete }: { base: KnowledgeBaseDetail | undefined; canDelete: boolean }) {
  const { t } = useT("kb");
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-title font-semibold text-destructive">{t(($) => $.manage.delete.title)}</h2>
      {canDelete && base ? (
        <div className="flex items-center gap-3.5 rounded-xl border bg-card p-4">
          <span className="flex-1 text-label text-muted-foreground">{t(($) => $.manage.delete.description)}</span>
          <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
            {t(($) => $.manage.delete.button)}
          </Button>
        </div>
      ) : (
        <p className="text-label text-muted-foreground">{t(($) => $.manage.delete.forbidden)}</p>
      )}
      {base && <KbDeleteDialog base={base} open={open} onClose={() => setOpen(false)} />}
    </section>
  );
}

/**
 * Knowledge base management (designs 11.1–11.3): raw files and export for
 * every member, deletion for the creator and owners / admins.
 */
export function KbManagePage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const { kbSlug, tab } = parseKbManageRoute(pathname);
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const canDelete = useCanConfigureKb(base?.created_by);

  const tabs: KbManageTab[] = canDelete ? ["raw", "export", "delete"] : ["raw", "export"];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <KbPageCrumb kbSlug={kbSlug} name={base?.name ?? kbSlug} title={t(($) => $.manage.title)} />
      </PageHeader>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <nav aria-label={t(($) => $.manage.tabs_label)} className="flex w-[180px] shrink-0 flex-col gap-0.5 px-2.5 py-4 max-md:w-full max-md:flex-row">
          {tabs.map((key) => (
            <AppLink
              key={key}
              href={p.kbManage(kbSlug, key)}
              aria-current={key === tab ? "page" : undefined}
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "h-[34px] justify-start rounded-lg px-2.5 font-normal",
                key === tab && "bg-surface-selected font-medium",
                key === "delete" && "text-destructive",
              )}
            >
              {t(($) => $.manage.tab[key])}
            </AppLink>
          ))}
        </nav>
        <div className="min-w-0 max-w-[760px] flex-1 overflow-y-auto px-7 pt-[18px] pb-10 max-md:px-4">
          {tab === "raw" && <RawFilesSection kbSlug={kbSlug} />}
          {tab === "export" && <ExportSection kbSlug={kbSlug} />}
          {tab === "delete" && <DeleteSection base={base} canDelete={canDelete} />}
        </div>
      </div>
    </div>
  );
}

