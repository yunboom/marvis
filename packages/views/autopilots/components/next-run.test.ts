// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AutopilotTrigger } from "@marvis/core/types";
import { earliestScheduledRun } from "./next-run";

function trigger(overrides: Partial<AutopilotTrigger>): AutopilotTrigger {
  return {
    id: "trg",
    autopilot_id: "ap-1",
    kind: "schedule",
    enabled: true,
    cron_expression: "0 9 * * *",
    timezone: "UTC",
    next_run_at: "2126-07-14T09:00:00Z",
    webhook_token: null,
    label: null,
    last_fired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("earliestScheduledRun", () => {
  it("returns nothing without a live schedule", () => {
    expect(earliestScheduledRun([])).toBeNull();
    expect(
      earliestScheduledRun([
        trigger({ id: "off", enabled: false }),
        trigger({ id: "hook", kind: "webhook", cron_expression: null, next_run_at: null }),
        trigger({ id: "pending", next_run_at: null }),
      ]),
    ).toBeNull();
  });

  it("picks the earliest instant, not the earliest string", () => {
    // Offsets differ, so lexical order of the ISO strings would pick wrong.
    const later = trigger({ id: "later", next_run_at: "2126-07-14T09:00:00+00:00", timezone: "UTC" });
    const sooner = trigger({ id: "sooner", next_run_at: "2126-07-14T16:00:00+09:00", timezone: "Asia/Tokyo" });

    expect(earliestScheduledRun([later, sooner])).toEqual({
      at: "2126-07-14T16:00:00+09:00",
      timeZone: "Asia/Tokyo",
    });
  });

  it("skips disabled schedules even when they keep a sooner next_run_at", () => {
    const disabled = trigger({ id: "off", enabled: false, next_run_at: "2126-01-01T00:00:00Z" });
    const live = trigger({ id: "on", next_run_at: "2126-02-01T00:00:00Z", timezone: null });

    expect(earliestScheduledRun([disabled, live])).toEqual({
      at: "2126-02-01T00:00:00Z",
      timeZone: undefined,
    });
  });
});
