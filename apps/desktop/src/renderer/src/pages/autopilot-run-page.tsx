import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AutopilotRunPage as AutopilotRun } from "@marvis/views/autopilots/components";
import { useWorkspaceId } from "@marvis/core/hooks";
import { autopilotDetailOptions } from "@marvis/core/autopilots/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function AutopilotRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const wsId = useWorkspaceId();
  const { data } = useQuery(autopilotDetailOptions(wsId, id!));

  useDocumentTitle(data ? data.autopilot.title : "Autopilot");

  if (!id || !runId) return null;
  return <AutopilotRun autopilotId={id} runId={runId} />;
}
