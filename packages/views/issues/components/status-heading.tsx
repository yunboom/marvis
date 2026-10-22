import type { IssueStatus } from "@marvis/core/types";
import { StatusIcon } from "./status-icon";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useIssueStatuses } from "@marvis/core/issue-statuses/hooks";
import { useStatusLabel } from "../utils/status-label";

export function StatusHeading({
  status,
  count,
}: {
  status: IssueStatus;
  count: number;
}) {
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  const { categoryOf, colorOf, iconOf } = useIssueStatuses(wsId);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="inline-flex min-w-0 items-center gap-2 text-body font-semibold">
        <StatusIcon category={categoryOf(status)} color={colorOf(status)} icon={iconOf(status)} status={status} className="size-3.5 shrink-0" />
        <span className="truncate">{labelOf(status)}</span>
      </span>
      <span className="shrink-0 text-label tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}
