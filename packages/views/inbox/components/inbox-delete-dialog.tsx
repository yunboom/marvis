"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { useT } from "../../i18n";

/**
 * Confirms permanently deleting an archived notification group. Stays open
 * while the request runs and on failure; the caller closes it on success.
 */
export function InboxDeleteDialog({
  open,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useT("inbox");

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.delete_dialog.title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(($) => $.delete_dialog.description)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t(($) => $.delete_dialog.cancel)}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? t(($) => $.delete_dialog.deleting) : t(($) => $.delete_dialog.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
