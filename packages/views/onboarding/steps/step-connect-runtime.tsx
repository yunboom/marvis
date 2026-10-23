"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import { Card } from "@marvis/ui/components/ui/card";
import { cn } from "@marvis/ui/lib/utils";
import { groupRuntimesByMachine, splitRuntimeDeviceInfo } from "@marvis/core/runtimes";
import { runtimeKeys } from "@marvis/core/runtimes/queries";
import type { AgentRuntime } from "@marvis/core/types";
import { DragStrip } from "../../platform";
import { MikaRuntimeChoice } from "../../runtimes/components/mika-runtime-choice";
import { MIKA_AVATAR_SRC } from "../components/mika-avatar";
import { SetupProgress } from "../components/setup-progress";
import { useRuntimePicker } from "../components/use-runtime-picker";
import { useT } from "../../i18n";

/** Idle ms before an empty list flips from "scanning" to "empty" — unless the
 *  platform reports runtimes are still pending (see `runtimesPending`). */
const EMPTY_TIMEOUT_MS = 5000;

/** Absolute ceiling: even while the platform still reports runtimes pending,
 *  fall back to the empty state after this so a wedged version probe can never
 *  hang the step on the scanning skeleton forever. */
const EMPTY_HARD_TIMEOUT_MS = 20000;

// Single canonical download destination — the /download page owns OS + arch
// detection and the release assets.
const DOWNLOAD_PAGE_URL = "/download";

type Phase = "found" | "scanning" | "empty" | "waiting";

/**
 * Connect a runtime, then start Mika on it. One page for both platforms:
 *
 *   - Desktop (no `cliInstructions`) scans the bundled daemon's runtimes:
 *     scanning skeleton, then the runtime list, or an empty state with
 *     Refresh once nothing registers.
 *   - Web lays the CLI install commands out inline and listens for the
 *     daemon to register; the runtime list replaces them once one does.
 *
 * Data layer (`useRuntimePicker`): polls every 2s while empty, refetches on
 * `daemon:register`, and preselects an online runtime.
 */
export function StepConnectRuntime({
  wsId,
  wsSlug,
  onNext,
  onRefresh,
  runtimesPending,
  cliInstructions,
}: {
  wsId: string;
  /** Slug of the target workspace. Sent explicitly so the runtime list reads
   *  the workspace being set up rather than whichever one the app is currently
   *  showing. */
  wsSlug?: string;
  onNext: (runtime: AgentRuntime | null, model?: string) => void | Promise<void>;
  /** Desktop restarts the bundled daemon so a freshly installed CLI shows up —
   *  otherwise its PATH probe runs once at boot and never re-probes. */
  onRefresh?: () => void | Promise<void>;
  /** Desktop-only: the local daemon is still booting or probing CLIs. While
   *  true the step keeps scanning past the soft timeout instead of flashing a
   *  false "no tools" state (MUL-5119). */
  runtimesPending?: boolean;
  /** Web's CLI install commands. Its presence is the web signal. */
  cliInstructions?: ReactNode;
}) {
  const { t } = useT("onboarding");
  const qc = useQueryClient();
  const isWeb = !!cliInstructions;
  const { runtimes, selected, selectedId, setSelectedId } = useRuntimePicker(
    wsId,
    wsSlug,
  );

  // Two timers decide when an empty desktop list stops "scanning": the soft
  // one yields to `runtimesPending`, the hard one never does. Refresh bumps
  // `scanEpoch` to give a freshly installed CLI another scanning window.
  const [scanEpoch, setScanEpoch] = useState(0);
  const [softTimedOut, setSoftTimedOut] = useState(false);
  const [hardTimedOut, setHardTimedOut] = useState(false);
  useEffect(() => {
    if (isWeb || runtimes.length > 0) return;
    setSoftTimedOut(false);
    setHardTimedOut(false);
    const soft = window.setTimeout(() => setSoftTimedOut(true), EMPTY_TIMEOUT_MS);
    const hard = window.setTimeout(
      () => setHardTimedOut(true),
      EMPTY_HARD_TIMEOUT_MS,
    );
    return () => {
      window.clearTimeout(soft);
      window.clearTimeout(hard);
    };
  }, [isWeb, runtimes.length, scanEpoch]);

  const phase: Phase =
    runtimes.length > 0
      ? "found"
      : isWeb
        ? "waiting"
        : hardTimedOut || (softTimedOut && runtimesPending !== true)
          ? "empty"
          : "scanning";

  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = starting || skipping;

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (onRefresh) await onRefresh();
      await qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      setScanEpoch((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, qc, wsId, refreshing]);

  const canStart = phase === "found" && selected !== null;
  const handleStart = async () => {
    if (!canStart || busy) return;

    setStarting(true);
    try {
      await onNext(selected, model || undefined);
    } finally {
      setStarting(false);
    }
  };

  // Skip is always available: it creates the install-runtime guide issue.
  const handleSkip = async () => {
    if (busy) return;

    setSkipping(true);
    try {
      await onNext(null);
    } finally {
      setSkipping(false);
    }
  };

  const refreshButton = (
    <RefreshButton onClick={handleRefresh} refreshing={refreshing} />
  );

  // The same host-free label the grouped list shows, so the summary does not
  // repeat the machine ("Claude (dev-box) · dev-box").
  const selectedEntry = selected
    ? groupRuntimesByMachine([selected])[0]?.runtimes[0]
    : undefined;
  const selectedHost = selected
    ? splitRuntimeDeviceInfo(selected.device_info).host
    : "";
  const summary =
    canStart && selectedEntry
      ? selectedHost
        ? t(($) => $.step_connect.summary_running_on, {
            runtime: selectedEntry.label,
            host: selectedHost,
          })
        : selectedEntry.label
      : t(($) => $.step_connect.summary_pick);

  // Two panes so the whole step fits one screen: context and actions on the
  // left (the buttons never scroll away), the choice on the right, which
  // scrolls on its own when a member has many runtimes.
  return (
    <div className="flex min-h-svh flex-col bg-app-shell">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-[960px] gap-0 overflow-hidden rounded-[28px] border-0 p-0 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border md:grid md:h-[600px] md:grid-cols-[380px_minmax(0,1fr)] dark:shadow-none">
          <div className="flex flex-col p-10">
            <SetupProgress current="runtime" />

            <h1 className="mt-10 text-display-sm font-bold">
              {t(($) => $.step_connect.title)}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted-foreground">
              {t(($) => $.step_connect.subtitle)}
            </p>

            <div className="mt-7 flex items-center gap-3 rounded-2xl bg-surface-sunken px-3.5 py-3">
              <img
                src={MIKA_AVATAR_SRC}
                alt=""
                className="size-9 shrink-0 select-none rounded-full object-cover"
              />
              <div className="min-w-0">
                <p className="text-body font-semibold">
                  {t(($) => $.step_connect.mika_name)}
                </p>
                <p aria-live="polite" className="truncate text-caption text-muted-foreground">
                  {summary}
                </p>
              </div>
            </div>

            <div className="mt-auto flex flex-col pt-8">
              <Button
                className="h-12 w-full text-body-lg"
                disabled={!canStart || busy}
                onClick={handleStart}
              >
                {starting && <Loader2 className="size-4 animate-spin" />}
                {starting
                  ? t(($) => $.step_connect.starting)
                  : t(($) => $.step_connect.start)}
              </Button>
              <Button
                variant="ghost"
                className="mt-2 h-11 w-full text-body-lg font-normal"
                disabled={busy}
                onClick={handleSkip}
              >
                {skipping && <Loader2 className="size-4 animate-spin" />}
                {t(($) => $.step_connect.skip)}
              </Button>
              <p className="mt-1 text-center text-label text-muted-foreground">
                {t(($) => $.step_connect.skip_note)}
              </p>
            </div>
          </div>

          <div className="flex min-h-0 flex-col px-6 pb-6 md:py-8 md:pr-8 md:pl-2">
            <ChoicePanel scrollKey={`${phase}:${runtimes.length}`}>
              <div key={phase} className="animate-onboarding-enter">
                {phase === "found" && (
                  <MikaRuntimeChoice
                    layout="grouped"
                    runtimes={runtimes}
                    value={{ runtimeId: selectedId ?? "", model }}
                    onChange={(next) => {
                      if (next.runtimeId !== selectedId) setSelectedId(next.runtimeId);
                      setModel(next.model);
                    }}
                    disabled={busy}
                    modelLabel={t(($) => $.step_connect.model_label)}
                    headerAction={refreshButton}
                  />
                )}

                {phase === "scanning" && <ScanningView />}

                {phase === "empty" && (
                  <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-8 text-center">
                    <p className="text-body-lg font-medium">
                      {t(($) => $.step_connect.empty_title)}
                    </p>
                    <p className="max-w-[340px] text-body leading-relaxed text-muted-foreground">
                      {t(($) => $.step_connect.empty_hint)}
                    </p>
                    <div className="mt-2">{refreshButton}</div>
                  </div>
                )}

                {phase === "waiting" && (
                  <div className="flex flex-col gap-4 p-3">
                    <span className="text-body font-medium">
                      {t(($) => $.step_connect.web_title)}
                    </span>
                    {cliInstructions}
                    <WaitingStatus />
                    <p className="text-label text-muted-foreground">
                      {t(($) => $.step_connect.download_prompt)}{" "}
                      <a
                        href={DOWNLOAD_PAGE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-foreground underline underline-offset-[3px]"
                      >
                        {t(($) => $.step_connect.download_link)}
                      </a>
                    </p>
                  </div>
                )}
              </div>
            </ChoicePanel>
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * The right-hand pane: a sunken panel that scrolls on its own. When runtime
 * rows sit below the fold it fades the bottom edge and offers a "N more"
 * jump, so a long list never hides that there is more to pick from.
 */
function ChoicePanel({
  scrollKey,
  children,
}: {
  /** Changes when the content changes, to recount what is below the fold. */
  scrollKey: string;
  children: ReactNode;
}) {
  const { t } = useT("onboarding");
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);

  const recount = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const fold = el.scrollTop + el.clientHeight;
    const rows = el.querySelectorAll<HTMLElement>('[role="radio"]');
    let count = 0;
    rows.forEach((row) => {
      if (row.offsetTop + row.offsetHeight / 2 > fold) count += 1;
    });
    setBelow(count);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    recount();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recount);
    observer.observe(el);
    return () => observer.disconnect();
  }, [recount, scrollKey]);

  const scrollDown = () => {
    const el = ref.current;
    if (!el) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ top: el.clientHeight * 0.8, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-[20px] bg-surface-sunken">
      <div ref={ref} onScroll={recount} className="relative min-h-0 flex-1 overflow-y-auto p-2">
        {children}
      </div>
      {below > 0 ? (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-18 bg-linear-to-b from-transparent to-surface-sunken"
          />
          <button
            type="button"
            onClick={scrollDown}
            className="absolute bottom-3.5 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground pr-3 pl-2.5 text-caption text-background shadow-[0_4px_12px_rgba(0,0,0,0.16)]"
          >
            <ArrowDown className="size-3" aria-hidden />
            {t(($) => $.step_connect.more_runtimes, { count: below })}
          </button>
        </>
      ) : null}
    </div>
  );
}

function ScanningView() {
  const { t } = useT("onboarding");
  return (
    <div>
      <p aria-live="polite" className="text-body text-muted-foreground">
        {t(($) => $.step_connect.scanning)}
      </p>
      <div aria-hidden className="mt-3 flex flex-col gap-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex h-16 animate-pulse items-center gap-3 rounded-xl border border-surface-border px-4"
          >
            <div className="size-7 shrink-0 rounded-lg bg-skeleton" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-30 rounded-xs bg-skeleton" />
              <div className="h-2 w-20 rounded-xs bg-skeleton" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RefreshButton({
  onClick,
  refreshing,
}: {
  onClick: () => void;
  refreshing: boolean;
}) {
  const { t } = useT("onboarding");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={refreshing}
      onClick={onClick}
      className="shrink-0 gap-1.5 px-2.5 text-muted-foreground"
    >
      <RefreshCw
        className={cn("size-3.5", refreshing && "animate-spin")}
        aria-hidden
      />
      {refreshing
        ? t(($) => $.step_connect.refreshing)
        : t(($) => $.step_connect.refresh)}
    </Button>
  );
}

/** Format a seconds count as `m:ss` (e.g. 75 → "1:15"). */
function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Live status while the web page waits for the first daemon to register. The
 * install, login, and daemon start happen in the member's terminal and
 * browser, so all this can do is confirm it is listening (pulsing dot plus a
 * ticking clock) and reveal troubleshooting hints as time passes. Rough
 * stage thresholds for `marvis setup`: under 15s is normal, 15–45s is likely
 * browser auth, 45–90s likely a terminal error, beyond that nothing is coming
 * through.
 */
function WaitingStatus() {
  const { t } = useT("onboarding");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const stage: "normal" | "midway" | "slow" | "stalled" =
    elapsed < 15
      ? "normal"
      : elapsed < 45
        ? "midway"
        : elapsed < 90
          ? "slow"
          : "stalled";
  const setupCmd = <span className="font-mono">{"marvis setup"}</span>;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-sunken px-3.5 py-3">
      <div className="flex items-center gap-2 text-label">
        <span
          aria-hidden
          className="size-2 shrink-0 animate-pulse rounded-full bg-success"
        />
        <span className="font-medium">{t(($) => $.step_connect.waiting)}</span>
        <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <p
        aria-live="polite"
        className="text-label leading-relaxed text-muted-foreground"
      >
        {stage === "normal" && (
          <>
            {t(($) => $.step_connect.stage_normal_prefix)}
            {setupCmd}
            {t(($) => $.step_connect.stage_normal_suffix)}
          </>
        )}
        {stage === "midway" && (
          <>
            {t(($) => $.step_connect.stage_midway_prefix)}
            {setupCmd}
            {t(($) => $.step_connect.stage_midway_suffix)}
          </>
        )}
        {stage === "slow" && (
          <>
            {t(($) => $.step_connect.stage_slow_prefix)}
            {setupCmd}
            {t(($) => $.step_connect.stage_slow_suffix)}
          </>
        )}
        {stage === "stalled" && (
          <>
            {t(($) => $.step_connect.stage_stalled_prefix)}
            <span className="font-medium text-foreground">
              {t(($) => $.step_connect.stage_stalled_term)}
            </span>
            {t(($) => $.step_connect.stage_stalled_suffix)}
          </>
        )}
      </p>
    </div>
  );
}
