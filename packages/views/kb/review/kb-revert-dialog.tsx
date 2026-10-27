"use client";

import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRevertKbMergeRequest } from "@marvis/core/kb/mutations";
import { useWorkspacePaths } from "@marvis/core/paths";
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
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { kbErrorCode } from "../utils/kb-api-error";

const API_CODE_REVERT_CONFLICT = "revert_conflict";

/** The merged request a revert dialog asks about. */
export interface KbRevertTarget {
  number: number;
  title: string;
}

/**
 * Confirms reverting a merged request (designs 2.8, 7.3). The revert opens a
 * new merge request; a later change to the same content refuses it (2.9).
 */
export function KbRevertDialog({
  kbSlug,
  target,
  onClose,
}: {
  kbSlug: string;
  target: KbRevertTarget | null;
  onClose: () => void;
}) {
  const { t } = useT("kb");
  const p = useWorkspacePaths();
  const navigation = useNavigation();
  const revert = useRevertKbMergeRequest();

  const submit = () => {
    if (!target) return;
    revert.mutate(target.number, {
      onSuccess: (created) => {
        onClose();
        toast.success(t(($) => $.review.reverted, { number: created.number }), {
          action: {
            label: t(($) => $.review.go_review),
            onClick: () => navigation.push(p.kbMergeRequest(kbSlug, created.number)),
          },
        });
      },
      onError: (error) => {
        onClose();
        toast.error(
          kbErrorCode(error) === API_CODE_REVERT_CONFLICT ? t(($) => $.review.revert_conflict) : t(($) => $.review.revert_failed),
        );
      },
    });
  };

  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open && !revert.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target ? t(($) => $.review.revert_confirm_title, { number: target.number, title: target.title }) : ""}
          </AlertDialogTitle>
          <AlertDialogDescription>{t(($) => $.review.revert_confirm_description)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revert.isPending}>{t(($) => $.review.cancel)}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revert.isPending}
            onClick={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {revert.isPending && <Loader2 className="size-4 animate-spin" />}
            {t(($) => $.review.revert_submit)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
