import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AutopilotDetailPage as AutopilotDetail } from "@marvis/views/autopilots/components";
import { useWorkspaceId } from "@marvis/core/hooks";
import { autopilotDetailOptions } from "@marvis/core/autopilots/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function AutopilotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsId = useWorkspaceId();
  const { data } = useQuery(autopilotDetailOptions(wsId, id!));

  // Plain text only — no leading ⚡ glyph in the title (MUL-4370).
  useDocumentTitle(data ? data.autopilot.title : "Autopilot");

  if (!id) return null;
  return <AutopilotDetail autopilotId={id} />;
}
