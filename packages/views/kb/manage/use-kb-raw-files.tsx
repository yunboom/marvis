"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { kbRawFileListOptions } from "@marvis/core/kb/queries";
import type { KbRawFile, KbRawFileItem } from "@marvis/core/types";
import { useAttachmentPreview } from "../../editor";
import { useT } from "../../i18n";
import type { KbRawFileActions } from "../components/kb-cite-card";

/** The path the reading page routes raw:// links to: /api/kb/raw/<id>/content[#page=N]. */
const RAW_CONTENT_HREF = /\/api\/kb\/raw\/([^/?#]+)\/content(?:[?#].*)?$/;

/** The raw file and PDF page a routed raw:// link opens, or null. */
export function parseKbRawHref(href: string | null): { id: string; page: number } | null {
  const match = href ? RAW_CONTENT_HREF.exec(href) : null;
  if (!match?.[1]) return null;

  const page = /#page=(\d+)/.exec(href ?? "");
  return { id: decodeURIComponent(match[1]), page: page?.[1] ? Number(page[1]) : 0 };
}

/** A raw files tab row as what citations carry. */
export function rawFileFromItem(item: KbRawFileItem, page = 0): KbRawFile {
  return {
    id: item.id,
    name: item.name,
    content_type: item.content_type,
    size: item.size,
    uploaded_by: item.uploaded_by,
    created_at: item.created_at,
    page,
  };
}

interface DesktopDownloadBridge {
  downloadURL?: (url: string) => Promise<void> | void;
}

/** Saves a URL: Electron's native download on desktop, an anchor on the web. */
export function saveUrl(url: string, filename = "") {
  const bridge = (window as unknown as { desktopAPI?: DesktopDownloadBridge }).desktopAPI;
  if (bridge?.downloadURL) {
    void bridge.downloadURL(url);
    return;
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export interface KbRawFilePreview {
  actions: KbRawFileActions;
  /** Opens a file a routed raw:// link points at, looked up in the knowledge base's files. */
  openLinked: (id: string, page: number) => void;
  /** The preview modal; render it anywhere. */
  modal: ReactNode;
}

/**
 * Opens raw files in the attachment preview (PDF on the cited page, images,
 * video, audio) and downloads the rest. URLs come from the content endpoint's
 * format=url, which loads without credentials on web and desktop.
 */
export function useKbRawFilePreview(kbSlug: string): KbRawFilePreview {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const preview = useAttachmentPreview();
  const { tryOpen } = preview;

  const download = useCallback(
    (file: KbRawFile) => {
      void api
        .getKnowledgeBaseRawFileUrl(file.id, { download: true })
        .then((url) => {
          if (!url) throw new Error("no download url");
          saveUrl(url, file.name);
        })
        .catch(() => toast.error(t(($) => $.manage.raw.open_failed)));
    },
    [t],
  );

  const open = useCallback(
    (file: KbRawFile) => {
      void api
        .getKnowledgeBaseRawFileUrl(file.id)
        .then((url) => {
          if (!url) throw new Error("no preview url");
          const pageFragment = file.page > 0 ? `#page=${file.page}` : "";
          if (!tryOpen({ kind: "url", url: url + pageFragment, filename: file.name })) download(file);
        })
        .catch(() => toast.error(t(($) => $.manage.raw.open_failed)));
    },
    [tryOpen, download, t],
  );

  const openLinked = useCallback(
    (id: string, page: number) => {
      void qc
        .fetchQuery(kbRawFileListOptions(wsId, kbSlug))
        .then((files) => {
          const item = files.find((f) => f.id === id);
          if (item) open(rawFileFromItem(item, page));
          else toast.error(t(($) => $.manage.raw.open_failed));
        })
        .catch(() => toast.error(t(($) => $.manage.raw.open_failed)));
    },
    [qc, wsId, kbSlug, open, t],
  );

  const actions = useMemo(() => ({ open, download }), [open, download]);

  return { actions, openLinked, modal: preview.modal };
}
