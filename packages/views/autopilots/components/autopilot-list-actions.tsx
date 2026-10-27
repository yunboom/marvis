"use client";

import { useState } from "react";
import {
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Autopilot } from "@marvis/core/types";
import {
  useDeleteAutopilot,
  useUpdateAutopilot,
} from "@marvis/core/autopilots";
import { useWorkspacePaths } from "@marvis/core/paths";
import { Button } from "@marvis/ui/components/ui/button";
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
import { DeferredTooltip } from "@marvis/ui/components/common/deferred-tooltip";
import { useT } from "../../i18n";
import { rowLinkInteractiveProps, useIntentNavigate } from "../../navigation";

export function DeleteAutopilotDialog({
  row,
  open,
  onOpenChange,
}: {
  row: Autopilot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("autopilots");
  const deleteAutopilot = useDeleteAutopilot();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteAutopilot.mutateAsync(row.id);
      onOpenChange(false);
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
            {t(($) => $.actions.delete_dialog.description, { name: row.title })}
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

// Card kebab — the card is a plain `<div>` whose whole-card navigation is a
// mouse `onClick` / `onAuxClick` (see `useRowLink`), not an ancestor `<a>`.
// The wrapper stops both so opening this menu never navigates the card.

export function AutopilotRowActions({ row }: { row: Autopilot }) {
  const { t } = useT("autopilots");
  const { t: tCommon } = useT("common");
  const wsPaths = useWorkspacePaths();
  const intentNavigate = useIntentNavigate();
  const updateAutopilot = useUpdateAutopilot();
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Apart from the navigation entry the kebab only holds write actions
  // (pause/resume/delete), so hide it entirely for members without write
  // access — they still reach a new tab through a modified card click. An
  // absent can_write (older server) keeps the menu visible and lets the
  // backend remain the gate.
  if (row.can_write === false) return null;

  const setStatus = async (status: "active" | "paused") => {
    try {
      await updateAutopilot.mutateAsync({ id: row.id, status });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <span {...rowLinkInteractiveProps} className="flex items-center">
      <DropdownMenu>
        <DeferredTooltip
          content={t(($) => $.actions.row_menu)}
          trigger={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t(($) => $.actions.row_menu)}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--motion-fast) ease-out hover:bg-accent hover:text-accent-foreground hover:duration-(--motion-instant) group-hover/card:opacity-100 focus-visible:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100 data-popup-open:text-accent-foreground"
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
            <DropdownMenuItem onClick={() => setStatus("paused")}>
              <Pause className="size-3.5" />
              {t(($) => $.actions.pause)}
            </DropdownMenuItem>
          )}
          {row.status === "paused" && (
            <DropdownMenuItem onClick={() => setStatus("active")}>
              <Play className="size-3.5" />
              {t(($) => $.actions.resume)}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {t(($) => $.actions.delete)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAutopilotDialog
        row={row}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </span>
  );
}
