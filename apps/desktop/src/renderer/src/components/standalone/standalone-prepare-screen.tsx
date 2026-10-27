import { useState } from "react";
import { Check, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { Button } from "@marvis/ui/components/ui/button";
import {
  SplitCard,
  SplitCardActions,
  SplitCardIntro,
  SplitCardPane,
} from "@marvis/ui/components/common/split-card";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "@marvis/views/i18n";
import {
  DEFAULT_STANDALONE_PORT,
  STANDALONE_ERROR_CHECKSUM,
  STANDALONE_ERROR_DISK,
  STANDALONE_ERROR_MANIFEST,
  STANDALONE_ERROR_NETWORK,
  STANDALONE_ERROR_PORT_IN_USE,
  STANDALONE_ERROR_START_FAILED,
  STANDALONE_ERROR_UNSUPPORTED_PLATFORM,
  STANDALONE_PHASE_DOWNLOADING,
  STANDALONE_PHASE_FAILED,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_PAUSED,
  STANDALONE_PHASE_RUNNING,
  STANDALONE_PHASE_STARTING,
  STANDALONE_PHASE_STOPPED,
  STANDALONE_PHASE_VERIFYING,
  type StandaloneError,
  type StandaloneStatus,
} from "../../../../shared/standalone";
import { StandaloneScreenFrame } from "./standalone-screen-frame";

// setup：连接页里首次准备资源；gate：已选单机模式但还没运行时的全窗口状态页。
export const PREPARE_MODE_SETUP = "setup";
export const PREPARE_MODE_GATE = "gate";
export type PrepareMode = typeof PREPARE_MODE_SETUP | typeof PREPARE_MODE_GATE;

// 页面展示的状态，由主进程的 phase 与页面用途合成。
const VIEW_DOWNLOADING = "downloading";
const VIEW_PAUSED = "paused";
const VIEW_VERIFYING = "verifying";
const VIEW_INSTALLING = "installing";
const VIEW_STARTING = "starting";
const VIEW_FAILED = "failed";
const VIEW_STOPPED = "stopped";
const VIEW_DONE = "done";

type PrepareView =
  | typeof VIEW_DOWNLOADING
  | typeof VIEW_PAUSED
  | typeof VIEW_VERIFYING
  | typeof VIEW_INSTALLING
  | typeof VIEW_STARTING
  | typeof VIEW_FAILED
  | typeof VIEW_STOPPED
  | typeof VIEW_DONE;

// 阶段条：下载 — 校验 — 安装。
const STEP_DOWNLOAD = 0;
const STEP_VERIFY = 1;
const STEP_INSTALL = 2;

const BYTES_PER_MB = 1024 * 1024;
const SECONDS_PER_MINUTE = 60;

const ACTION_RETRY = "retry";
const ACTION_ENTER = "enter";
const ACTION_CANCEL = "cancel";
type BusyAction = typeof ACTION_RETRY | typeof ACTION_ENTER | typeof ACTION_CANCEL;

const PRIMARY_BUTTON_CLASS = "h-12 w-full text-body-lg";
const SECONDARY_BUTTON_CLASS = "h-11 w-full text-body-lg";

function resolveView(status: StandaloneStatus | null, mode: PrepareMode): PrepareView {
  switch (status?.phase) {
    case STANDALONE_PHASE_DOWNLOADING:
      return VIEW_DOWNLOADING;
    case STANDALONE_PHASE_PAUSED:
      return VIEW_PAUSED;
    case STANDALONE_PHASE_VERIFYING:
      return VIEW_VERIFYING;
    case STANDALONE_PHASE_INSTALLING:
      return VIEW_INSTALLING;
    case STANDALONE_PHASE_STARTING:
      return VIEW_STARTING;
    case STANDALONE_PHASE_FAILED:
      return VIEW_FAILED;
    case STANDALONE_PHASE_RUNNING:
      return mode === PREPARE_MODE_SETUP ? VIEW_DONE : VIEW_STARTING;
    case STANDALONE_PHASE_STOPPED:
      return mode === PREPARE_MODE_SETUP ? VIEW_STARTING : VIEW_STOPPED;
    default:
      // 刚点「下载资源」，第一次进度还没推过来。
      return mode === PREPARE_MODE_SETUP ? VIEW_DOWNLOADING : VIEW_STOPPED;
  }
}

function failedStep(error: StandaloneError | null): number {
  switch (error?.code) {
    case STANDALONE_ERROR_CHECKSUM:
      return STEP_VERIFY;
    case STANDALONE_ERROR_PORT_IN_USE:
    case STANDALONE_ERROR_START_FAILED:
      return STEP_INSTALL;
    default:
      return STEP_DOWNLOAD;
  }
}

function currentStep(view: PrepareView, error: StandaloneError | null): number {
  switch (view) {
    case VIEW_DOWNLOADING:
    case VIEW_PAUSED:
      return STEP_DOWNLOAD;
    case VIEW_VERIFYING:
      return STEP_VERIFY;
    case VIEW_FAILED:
      return failedStep(error);
    default:
      return STEP_INSTALL;
  }
}

function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

export interface StandalonePrepareScreenProps {
  status: StandaloneStatus | null;
  mode: PrepareMode;
  /** 端口被占用时「修改设置」回到设置表单；只在 setup 模式提供。 */
  onEditSettings?: () => void;
  /** 取消准备后回到连接页。 */
  onCancelled?: () => void;
}

// 「准备资源」页：左栏标题、说明与按钮，右栏阶段条、进度与就绪状态。由主进程推送的状态驱动。
export function StandalonePrepareScreen({ status, mode, onEditSettings, onCancelled }: StandalonePrepareScreenProps) {
  const { t } = useT("settings");
  const [busy, setBusy] = useState<BusyAction | null>(null);

  const view = resolveView(status, mode);
  const error = status?.error ?? null;
  const installed = status?.version != null;
  const api = window.desktopAPI.standalone;

  const run = async (action: BusyAction, task: () => Promise<void>, failedMessage: string) => {
    setBusy(action);
    try {
      await task();
    } catch {
      toast.error(failedMessage);
    } finally {
      setBusy(null);
    }
  };

  const handleRetry = () =>
    void run(ACTION_RETRY, () => api.retry(), t(($) => $.desktop.standalone.prepare.action_failed));
  const handleEnter = () =>
    void run(ACTION_ENTER, () => api.enter(), t(($) => $.desktop.standalone.prepare.enter_failed));
  const handleCancel = () =>
    void run(
      ACTION_CANCEL,
      async () => {
        await api.cancel();
        onCancelled?.();
      },
      t(($) => $.desktop.standalone.prepare.action_failed),
    );
  const handleOpenLogs = () => void api.openLogs();

  const errorMessage = (): string => {
    const port = error?.port ?? DEFAULT_STANDALONE_PORT;
    switch (error?.code) {
      case STANDALONE_ERROR_PORT_IN_USE:
        return mode === PREPARE_MODE_SETUP
          ? t(($) => $.desktop.standalone.prepare.errors.port_in_use, { port })
          : t(($) => $.desktop.standalone.prepare.errors.port_in_use_running, { port });
      case STANDALONE_ERROR_NETWORK:
        return t(($) => $.desktop.standalone.prepare.errors.network);
      case STANDALONE_ERROR_CHECKSUM:
        return t(($) => $.desktop.standalone.prepare.errors.checksum);
      case STANDALONE_ERROR_DISK:
        return t(($) => $.desktop.standalone.prepare.errors.disk);
      case STANDALONE_ERROR_UNSUPPORTED_PLATFORM:
        return t(($) => $.desktop.standalone.prepare.errors.unsupported_platform);
      case STANDALONE_ERROR_MANIFEST:
        return t(($) => $.desktop.standalone.prepare.errors.manifest);
      case STANDALONE_ERROR_START_FAILED:
        return t(($) => $.desktop.standalone.prepare.errors.start_failed);
      default:
        return t(($) => $.desktop.standalone.prepare.action_failed);
    }
  };

  let title: string;
  let subtitle: string;
  switch (view) {
    case VIEW_PAUSED:
      title = t(($) => $.desktop.standalone.prepare.title_paused);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_paused);
      break;
    case VIEW_VERIFYING:
      title = t(($) => $.desktop.standalone.prepare.title_preparing);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_verifying);
      break;
    case VIEW_INSTALLING:
      title = t(($) => $.desktop.standalone.prepare.title_preparing);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_installing);
      break;
    case VIEW_STARTING:
      title = t(($) => $.desktop.standalone.prepare.title_preparing);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_starting);
      break;
    case VIEW_FAILED:
      title = installed
        ? t(($) => $.desktop.standalone.prepare.title_unavailable)
        : t(($) => $.desktop.standalone.prepare.title_failed);
      subtitle = errorMessage();
      break;
    case VIEW_STOPPED:
      title = t(($) => $.desktop.standalone.prepare.title_stopped);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_stopped);
      break;
    case VIEW_DONE:
      title = t(($) => $.desktop.standalone.prepare.title_done);
      subtitle = status?.lanUrl
        ? t(($) => $.desktop.standalone.prepare.subtitle_done_lan)
        : t(($) => $.desktop.standalone.prepare.subtitle_done_local);
      break;
    default:
      title = t(($) => $.desktop.standalone.prepare.title_preparing);
      subtitle = t(($) => $.desktop.standalone.prepare.subtitle_downloading);
  }

  const canCancel = view === VIEW_DOWNLOADING || view === VIEW_PAUSED;
  const canRetry = view === VIEW_FAILED || view === VIEW_STOPPED;
  const offerEditSettings =
    view === VIEW_FAILED && error?.code === STANDALONE_ERROR_PORT_IN_USE && onEditSettings !== undefined;

  return (
    <StandaloneScreenFrame>
      <SplitCard aria-label={t(($) => $.desktop.standalone.prepare.label)} role="region">
        <SplitCardIntro>
          <MarvisIcon className="size-9 text-foreground" />

          <h1 className="mt-8 text-display-sm font-bold [@media(max-height:760px)]:mt-5">{title}</h1>
          <p
            className={cn(
              "mt-3 text-body leading-relaxed",
              view === VIEW_FAILED ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </p>
        </SplitCardIntro>

        <SplitCardPane>
          <div className="flex min-h-[320px] flex-1 flex-col justify-center rounded-[20px] bg-surface-sunken px-11 py-10 md:min-h-0">
            {view === VIEW_DONE ? (
              <ReadyPanel version={status?.version ?? null} />
            ) : (
              <ProgressPanel status={status} view={view} mode={mode} />
            )}
          </div>
        </SplitCardPane>

        <SplitCardActions className="gap-2">
          {view === VIEW_DONE && (
            <Button
              size="lg"
              className={PRIMARY_BUTTON_CLASS}
              disabled={busy !== null}
              aria-busy={busy === ACTION_ENTER || undefined}
              onClick={handleEnter}
            >
              {busy === ACTION_ENTER && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {busy === ACTION_ENTER
                ? t(($) => $.desktop.standalone.prepare.entering)
                : t(($) => $.desktop.standalone.prepare.enter)}
            </Button>
          )}
          {canRetry && (
            <Button
              size="lg"
              className={PRIMARY_BUTTON_CLASS}
              disabled={busy !== null}
              aria-busy={busy === ACTION_RETRY || undefined}
              onClick={handleRetry}
            >
              {busy === ACTION_RETRY && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t(($) => $.desktop.standalone.prepare.retry)}
            </Button>
          )}
          {canRetry && offerEditSettings && (
            <Button variant="ghost" size="lg" className={SECONDARY_BUTTON_CLASS} onClick={onEditSettings}>
              {t(($) => $.desktop.standalone.prepare.edit_settings)}
            </Button>
          )}
          {canRetry && !offerEditSettings && (
            <Button variant="ghost" size="lg" className={SECONDARY_BUTTON_CLASS} onClick={handleOpenLogs}>
              {t(($) => $.desktop.standalone.prepare.view_logs)}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              size="lg"
              className={SECONDARY_BUTTON_CLASS}
              disabled={busy !== null}
              onClick={handleCancel}
            >
              {t(($) => $.desktop.standalone.prepare.cancel)}
            </Button>
          )}
        </SplitCardActions>
      </SplitCard>
    </StandaloneScreenFrame>
  );
}

interface ProgressPanelProps {
  status: StandaloneStatus | null;
  view: PrepareView;
  mode: PrepareMode;
}

function ProgressPanel({ status, view, mode }: ProgressPanelProps) {
  const { t } = useT("settings");
  const progress = status?.progress ?? null;
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const setup = mode === PREPARE_MODE_SETUP;
  const paused = view === VIEW_PAUSED;
  const failed = view === VIEW_FAILED;
  const indeterminate = view === VIEW_INSTALLING || view === VIEW_STARTING;
  const canToggle = view === VIEW_DOWNLOADING || paused;
  const step = currentStep(view, status?.error ?? null);
  const api = window.desktopAPI.standalone;

  let phaseLabel: string;
  switch (view) {
    case VIEW_PAUSED:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_paused);
      break;
    case VIEW_VERIFYING:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_verifying);
      break;
    case VIEW_INSTALLING:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_installing);
      break;
    case VIEW_STARTING:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_starting);
      break;
    case VIEW_FAILED:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_failed);
      break;
    case VIEW_STOPPED:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_stopped);
      break;
    default:
      phaseLabel = t(($) => $.desktop.standalone.prepare.phase_downloading);
  }

  const eta = (): string | null => {
    const seconds = progress?.etaSeconds;
    if (seconds === null || seconds === undefined) return null;
    if (seconds < SECONDS_PER_MINUTE) {
      return t(($) => $.desktop.standalone.prepare.eta_seconds, { count: Math.max(1, Math.ceil(seconds)) });
    }

    return t(($) => $.desktop.standalone.prepare.eta_minutes, {
      count: Math.ceil(seconds / SECONDS_PER_MINUTE),
    });
  };

  let metaLeft = "";
  let metaRight = "";
  if (progress && (view === VIEW_DOWNLOADING || paused || view === VIEW_VERIFYING)) {
    metaLeft = t(($) => $.desktop.standalone.prepare.size, {
      received: megabytes(progress.receivedBytes),
      total: megabytes(progress.totalBytes),
    });
  }
  if (view === VIEW_DOWNLOADING && progress) {
    const speed = megabytes(progress.bytesPerSecond);
    const remaining = eta();
    metaRight = remaining
      ? t(($) => $.desktop.standalone.prepare.speed_eta, { speed, eta: remaining })
      : t(($) => $.desktop.standalone.prepare.speed, { speed });
  } else if (paused) {
    metaRight = t(($) => $.desktop.standalone.prepare.paused_hint);
  } else if (view === VIEW_INSTALLING) {
    metaRight = t(($) => $.desktop.standalone.prepare.install_hint);
  }

  // 状态页（gate）只是等待启动，没有可量化的进度：整条显示流光。
  const barWidth = setup ? percent : 100;
  const steps = [
    t(($) => $.desktop.standalone.prepare.step_download),
    t(($) => $.desktop.standalone.prepare.step_verify),
    t(($) => $.desktop.standalone.prepare.step_install),
  ];

  return (
    <div className="flex flex-col">
      {setup && (
        <ol aria-label={t(($) => $.desktop.standalone.prepare.steps)} className="flex items-center gap-2.5 text-label">
          {steps.map((label, index) => {
            const current = index === step;
            const past = index < step;

            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2.5",
                  current ? "font-semibold text-foreground" : past ? "text-muted-foreground" : "text-faint-foreground",
                )}
              >
                {index > 0 && <span aria-hidden className="h-px w-5 bg-input" />}
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      current && failed && "bg-destructive",
                      current && !failed && "bg-foreground",
                      past && "bg-muted-foreground",
                      !current && !past && "bg-input",
                    )}
                  />
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {setup && (
        <div className="mt-10 flex items-baseline gap-1 tabular-nums">
          <span
            className={cn(
              "text-[72px] leading-[72px] font-bold tracking-tight",
              paused ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {percent}
          </span>
          <span className="text-display-sm font-semibold text-muted-foreground">%</span>
        </div>
      )}

      <p
        aria-live="polite"
        className={cn(
          "text-title-sm font-medium",
          setup ? "mt-3" : "mt-0",
          failed ? "text-destructive" : paused ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {phaseLabel}
      </p>

      <div className="mt-7 flex items-center gap-3.5">
        <div
          role="progressbar"
          aria-label={t(($) => $.desktop.standalone.prepare.progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate && !setup ? undefined : percent}
          className="h-2 flex-1 overflow-hidden rounded-full bg-black/8 dark:bg-white/10"
        >
          <div
            className={cn(
              "relative h-full overflow-hidden rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
              failed ? "bg-destructive" : paused ? "bg-faint-foreground" : "bg-foreground",
            )}
            style={{ width: `${barWidth}%` }}
          >
            {indeterminate && (
              <span
                aria-hidden
                data-testid="standalone-progress-sheen"
                className="absolute inset-0 animate-nav-progress-sweep bg-linear-to-r from-transparent via-white/45 to-transparent motion-reduce:hidden dark:via-black/35"
              />
            )}
          </div>
        </div>
        {canToggle && (
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0 bg-surface"
            aria-label={
              paused
                ? t(($) => $.desktop.standalone.prepare.resume)
                : t(($) => $.desktop.standalone.prepare.pause)
            }
            onClick={() => (paused ? api.resume() : api.pause())}
          >
            {paused ? (
              <Play className="size-3.5 fill-current" aria-hidden />
            ) : (
              <Pause className="size-3.5 fill-current" aria-hidden />
            )}
          </Button>
        )}
      </div>

      <div className="mt-3 flex min-h-5 items-center gap-3 text-label text-muted-foreground tabular-nums">
        <span>{metaLeft}</span>
        <span className={cn("ml-auto", paused && "text-warning")}>{metaRight}</span>
      </div>
    </div>
  );
}

// 资源就绪：对勾 + 版本。
function ReadyPanel({ version }: { version: string | null }) {
  const { t } = useT("settings");

  return (
    <div className="flex flex-col items-start">
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-full bg-foreground text-background motion-safe:animate-[popover-pop-in_200ms_ease-out]"
      >
        <Check className="size-6.5" strokeWidth={2.4} />
      </span>
      <p className="mt-6 text-title-lg font-bold">{t(($) => $.desktop.standalone.prepare.done_heading)}</p>
      {version && (
        <p className="mt-1.5 text-label text-muted-foreground">
          {t(($) => $.desktop.standalone.prepare.done_version, { version })}
        </p>
      )}
    </div>
  );
}
