"use client";

import type { InboxItem } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { useT } from "../../i18n";

function formatResetAt(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AutopilotQuotaNotice({
  item,
  onOpenRecovery,
}: {
  item: InboxItem;
  onOpenRecovery: () => void;
}) {
  const { t } = useT("inbox");
  const details = item.details ?? {};
  const resetAt = formatResetAt(details.reset_at);

  let body = item.body;
  if (details.limit && resetAt) {
    body = t(($) => $.detail.autopilot_quota_exceeded_body, {
      limit: details.limit,
      resetAt,
    });
  }

  return (
    <>
      {body && (
        <div className="mt-4.5 whitespace-pre-wrap text-body leading-relaxed text-foreground">
          {body}
        </div>
      )}
      <Button className="mt-5" onClick={onOpenRecovery}>
        {t(($) => $.detail.autopilot_quota_upgrade)}
      </Button>
    </>
  );
}
