"use client";

import { use } from "react";
import { AutopilotRunPage } from "@marvis/views/autopilots/components";

export default function Page({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = use(params);
  return <AutopilotRunPage autopilotId={id} runId={runId} />;
}
