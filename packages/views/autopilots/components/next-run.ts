import type { AutopilotTrigger } from "@marvis/core/types";

/** When an autopilot next fires on its own, in the zone of the schedule that fires it. */
export interface ScheduledRun {
  at: string;
  timeZone: string | undefined;
}

/**
 * The soonest upcoming run across the enabled schedule triggers.
 *
 * A disabled trigger keeps the next_run_at it had (the dispatcher filters on
 * `enabled` instead of clearing it), so it must not count. Instants are compared
 * as times, not strings: the server may send different offsets per trigger.
 */
export function earliestScheduledRun(triggers: readonly AutopilotTrigger[]): ScheduledRun | null {
  let best: { trigger: AutopilotTrigger; time: number } | null = null;

  for (const trigger of triggers) {
    if (trigger.kind !== "schedule" || !trigger.enabled || !trigger.next_run_at) continue;
    const time = Date.parse(trigger.next_run_at);
    if (Number.isNaN(time)) continue;
    if (!best || time < best.time) best = { trigger, time };
  }

  if (!best) return null;

  return {
    at: best.trigger.next_run_at as string,
    timeZone: best.trigger.timezone ?? undefined,
  };
}
