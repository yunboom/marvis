"use client";

import { useState } from "react";
import {
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Autopilot } from "@marvis/core/types";
import {
  useDeleteAutopilot,
  useUpdateAutopilot,
} from "@marvis/core/autopilots";
import { useWorkspacePaths } from "@marvis/core/paths";
import { Button } from "@marvis/ui/components/ui/button";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { isSystemAutopilot } from "../lib/system-autopilot";
import { useIntentNavigate } from "../../navigation";
import {
  COLLECTION_BATCH_ACTION,
  COLLECTION_BATCH_BAR,
  COLLECTION_BATCH_DIVIDER,
} from "../../layout/collection-page";
import { DeferredTooltip } from "@marvis/ui/components/common/deferred-tooltip";

// Delete dialog — single row (kebab) and batch share one implementation.

export function DeleteAutopilotsDialog({
  rows,
  open,
  onOpenChange,
  onDeleted,
}: {
  rows: Autopilot[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useT("autopilots");
  const deleteAutopilot = useDeleteAutopilot();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      for (const row of rows) {
        await deleteAutopilot.mutateAsync(row.id);
      }
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(($) => $.actions.delete_dialog.title)}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.actions.delete_dialog.description, {
              count: rows.length,
              name: rows[0]?.title ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.actions.delete_dialog.warning)}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.actions.delete_dialog.cancel)}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? (
              <>
                <Loader2 className="mr-1 size-3.5 animate-spin" />
                {t(($) => $.actions.delete_dialog.deleting)}
              </>
            ) : (
              t(($) => $.actions.delete_dialog.confirm)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Status helpers shared by kebab and batch toolbar.

function useSetStatus() {
  const updateAutopilot = useUpdateAutopilot();
  return async (rows: Autopilot[], status: "active" | "paused") => {
    try {
      for (const row of rows) {
        if (row.status === status) continue;
        await updateAutopilot.mutateAsync({ id: row.id, status });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
}

// Row kebab — the row is a plain `<div>` whose whole-row navigation is a mouse
// `onClick` (see `useRowLink`), not an ancestor `<a>`. The wrapper span stops
// click propagation so opening this menu never navigates the row — just
// stopPropagation, no preventDefault (same pattern as the skills list).

export function AutopilotRowActions({ row }: { row: Autopilot }) {
  const { t } = useT("autopilots");
  const { t: tCommon } = useT("common");
  const wsPaths = useWorkspacePaths();
  const intentNavigate = useIntentNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const setStatus = useSetStatus();

  // Apart from the navigation entry the kebab only holds write actions
  // (pause/resume/delete), so hide it entirely for members without write
  // access — they still reach a new tab through a modified row click. An
  // absent can_write (older server) keeps the menu visible and lets the
  // backend remain the gate.
  if (row.can_write === false) return null;

  return (
    <span
      onClick={(e) => e.stopPropagation()}
      className="flex items-center"
    >
      <DropdownMenu>
        <DeferredTooltip
          content={t(($) => $.actions.row_menu)}
          trigger={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t(($) => $.actions.row_menu)}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--motion-fast) ease-out hover:bg-accent hover:text-accent-foreground hover:duration-(--motion-instant) group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100 data-popup-open:text-accent-foreground"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              }
            />
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={() =>
              intentNavigate(
                wsPaths.autopilotDetail(row.id),
                "foreground-tab",
                row.title,
              )
            }
          >
            <ExternalLink className="size-3.5" />
            {tCommon(($) => $.navigation.open_in_new_tab)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {row.status === "active" && (
            <DropdownMenuItem onClick={() => setStatus([row], "paused")}>
              <Pause className="size-3.5" />
              {t(($) => $.actions.pause)}
            </DropdownMenuItem>
          )}
          {row.status === "paused" && (
            <DropdownMenuItem onClick={() => setStatus([row], "active")}>
              <Play className="size-3.5" />
              {t(($) => $.actions.resume)}
            </DropdownMenuItem>
          )}
          {!isSystemAutopilot(row) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-3.5" />
                {t(($) => $.actions.delete)}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAutopilotsDialog
        rows={[row]}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </span>
  );
}

// Batch toolbar

export function AutopilotBatchToolbar({
  rows,
  onClear,
}: {
  rows: Autopilot[];
  onClear: () => void;
}) {
  const { t } = useT("autopilots");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const setStatus = useSetStatus();

  if (rows.length === 0) return null;

  const anyActive = rows.some((r) => r.status === "active");
  const anyPaused = rows.some((r) => r.status === "paused");
  // Built-in autopilots cannot be deleted; batch delete acts on the rest.
  const deletable = rows.filter((r) => !isSystemAutopilot(r));

  return (
    <>
      {/* Anchored to the page root (relative), NOT the viewport — see the
          skills batch toolbar for the rationale. */}
      <div role="toolbar" className={COLLECTION_BATCH_BAR}>
        <span className="whitespace-nowrap text-body font-medium">
          {t(($) => $.actions.selected, { count: rows.length })}
        </span>
        <TooltipHint label={t(($) => $.actions.clear_selection)}>
          <button
            type="button"
            aria-label={t(($) => $.actions.clear_selection)}
            onClick={onClear}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:text-foreground hover:duration-(--motion-instant)"
          >
            <X className="size-3.5" />
          </button>
        </TooltipHint>
        <span aria-hidden="true" className={COLLECTION_BATCH_DIVIDER} />

        {anyActive && (
          <Button
            variant="ghost"
            size="sm"
            className={COLLECTION_BATCH_ACTION}
            onClick={() => setStatus(rows, "paused")}
          >
            <Pause className="size-3.5" />
            {t(($) => $.actions.pause)}
          </Button>
        )}
        {anyPaused && (
          <Button
            variant="ghost"
            size="sm"
            className={COLLECTION_BATCH_ACTION}
            onClick={() => setStatus(rows, "active")}
          >
            <Play className="size-3.5" />
            {t(($) => $.actions.resume)}
          </Button>
        )}
        {deletable.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              COLLECTION_BATCH_ACTION,
              "text-destructive hover:text-destructive aria-expanded:text-destructive",
            )}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {t(($) => $.actions.delete)}
          </Button>
        )}
      </div>

      <DeleteAutopilotsDialog
        rows={deletable}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onClear}
      />
    </>
  );
}
