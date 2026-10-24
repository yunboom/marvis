"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, clientErrorMessage } from "@marvis/core/api";
import { autopilotKeys } from "@marvis/core/autopilots/queries";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeDigestOptions, knowledgeKeys, type KnowledgeDigest } from "@marvis/core/knowledge";
import { useWorkspacePaths } from "@marvis/core/paths";
import type { Agent } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Switch } from "@marvis/ui/components/ui/switch";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { MaintainerAgentSelect } from "./maintainer-agent-select";

const DEFAULT_TIME = "22:00";
const AUTOPILOT_ACTIVE = "active";
const AUTOPILOT_PAUSED = "paused";
const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** Daily cron "M H * * *" for an "HH:MM" time. */
export function dailyCron(time: string): string {
  const [h = "22", m = "0"] = time.split(":");

  return `${Number(m)} ${Number(h)} * * *`;
}

/** "HH:MM" for a daily cron, or null for any other schedule. */
export function cronToDailyTime(cron: string | null): string | null {
  const match = cron ? DAILY_CRON.exec(cron) : null;
  if (!match) return null;

  return `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Workspace-wide daily knowledge digest: setup, enable switch and a link to its automation. */
export function KnowledgeDigestSection({
  agents,
  defaultAgentId,
  isAdmin,
}: {
  agents: Agent[];
  defaultAgentId: string | null;
  isAdmin: boolean;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const qc = useQueryClient();
  const { data: digest } = useQuery(knowledgeDigestOptions(wsId));

  const [agentId, setAgentId] = useState<string | null>(defaultAgentId);
  const [time, setTime] = useState(DEFAULT_TIME);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: knowledgeKeys.digest(wsId) }),
      qc.invalidateQueries({ queryKey: autopilotKeys.all(wsId) }),
    ]);
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      toast.error(clientErrorMessage(err) || t(($) => $.digest.failed));
    } finally {
      setBusy(false);
    }
  };

  if (!digest) return null;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-title-sm font-semibold">{t(($) => $.digest.title)}</h2>
        <p className="text-caption text-muted-foreground">{t(($) => $.digest.hint)}</p>
      </div>
      {digest.autopilot ? (
        <DigestStatus digest={digest} isAdmin={isAdmin} busy={busy} onToggle={(on) =>
          void run(() => api.updateAutopilot(digest.autopilot!.id, { status: on ? AUTOPILOT_ACTIVE : AUTOPILOT_PAUSED }))
        } detailHref={wsPaths.autopilotDetail(digest.autopilot.id)} />
      ) : isAdmin ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="space-y-1.5">
            <Label htmlFor="kb-digest-agent">{t(($) => $.digest.agent)}</Label>
            <MaintainerAgentSelect id="kb-digest-agent" agents={agents} value={agentId} disabled={busy} onChange={setAgentId} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-digest-time">{t(($) => $.digest.time)}</Label>
            <Input id="kb-digest-time" type="time" className="w-32" value={time} disabled={busy} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div>
            <Button
              disabled={!agentId || !time || busy}
              aria-busy={busy}
              onClick={() =>
                void run(() => api.createKnowledgeDigest({ assignee_id: agentId!, cron_expression: dailyCron(time), timezone: browserTimeZone() }))
              }
            >
              {t(($) => $.digest.setup)}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-caption text-muted-foreground">{t(($) => $.digest.admin_only)}</p>
      )}
    </section>
  );
}

function DigestStatus({
  digest,
  isAdmin,
  busy,
  onToggle,
  detailHref,
}: {
  digest: KnowledgeDigest;
  isAdmin: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  detailHref: string;
}) {
  const { t } = useT("knowledge");
  const ap = digest.autopilot!;
  const active = ap.status === AUTOPILOT_ACTIVE;
  const noBase = digest.knowledge_base_count === 0;
  const tz = digest.schedule?.timezone ?? "UTC";
  const daily = cronToDailyTime(digest.schedule?.cron_expression ?? null);
  const schedule = daily
    ? t(($) => $.digest.schedule_daily, { time: daily, tz })
    : t(($) => $.digest.schedule_cron, { cron: digest.schedule?.cron_expression ?? "", tz });

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-4">
      <Switch
        checked={active}
        disabled={!isAdmin || busy || (!active && noBase)}
        aria-label={t(($) => $.digest.enable_aria)}
        onCheckedChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{active ? t(($) => $.digest.status_active) : t(($) => $.digest.status_paused)}</div>
        <div className="text-caption text-muted-foreground">{noBase ? t(($) => $.digest.no_knowledge_base) : schedule}</div>
      </div>
      <Button variant="outline" size="sm" render={<AppLink href={detailHref} />}>
        {t(($) => $.digest.open_automation)}
      </Button>
    </div>
  );
}
