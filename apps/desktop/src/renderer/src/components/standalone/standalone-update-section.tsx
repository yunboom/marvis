import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@marvis/ui/components/ui/button";
import { Switch } from "@marvis/ui/components/ui/switch";
import { cn } from "@marvis/ui/lib/utils";
import { useT, useTimeAgo } from "@marvis/views/i18n";
import { SettingsSection } from "@marvis/views/settings";
import {
  STANDALONE_UPDATE_AVAILABLE,
  STANDALONE_UPDATE_DOWNLOADING,
  STANDALONE_UPDATE_INSTALLING,
  STANDALONE_UPDATE_ROLLED_BACK,
  type StandaloneStatus,
} from "../../../../shared/standalone";
import { approxMegabytes, megabytes, useEtaLabel, useNow } from "./standalone-format";
import { useStandaloneStatus } from "./use-standalone-status";

// 安装进度没有细分事件，固定高亮中间的「安装资源」。
const INSTALLING_STEP = 1;
const PERCENT_MAX = 100;

const ACTION_CHECK = "check";
const ACTION_INSTALL = "install";
type UpdateAction = typeof ACTION_CHECK | typeof ACTION_INSTALL;

// 设置 · 更新 › 单机模式资源：检查、下载、安装资源更新，失败时已自动恢复。
export function StandaloneUpdateSection() {
  const { t } = useT("settings");
  const status = useStandaloneStatus();
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const autoLabelId = useId();

  useEffect(() => {
    let cancelled = false;

    window.desktopAPI.standalone
      .autoDownloadUpdates()
      .then((enabled) => {
        if (!cancelled) setAutoDownload(enabled);
      })
      .catch(() => {
        // 主进程读不到偏好时按开启处理，界面保持一致。
        if (!cancelled) setAutoDownload(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoChange = async (enabled: boolean) => {
    setSavingAuto(true);

    try {
      await window.desktopAPI.standalone.setAutoDownloadUpdates(enabled);
      setAutoDownload(enabled);
    } catch {
      toast.error(t(($) => $.desktop.standalone.prepare.action_failed));
    } finally {
      setSavingAuto(false);
    }
  };

  return (
    <SettingsSection title={t(($) => $.desktop.standalone.update.heading)}>
      <div className="flex flex-col rounded-xl ring-1 ring-surface-border">
        {status !== null && <UpdateStateBlock status={status} />}

        <div
          className={cn(
            "flex min-h-12 items-center gap-3 px-5 py-2",
            status !== null && "border-t border-surface-border",
          )}
        >
          <span id={autoLabelId} className="flex-1 text-body">
            {t(($) => $.desktop.standalone.update.auto_download)}
          </span>
          <Switch
            aria-labelledby={autoLabelId}
            checked={autoDownload ?? true}
            disabled={autoDownload === null || savingAuto}
            onCheckedChange={(next) => void handleAutoChange(next)}
          />
        </div>
      </div>
    </SettingsSection>
  );
}

function UpdateStateBlock({ status }: { status: StandaloneStatus }) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const eta = useEtaLabel();
  // 让「上次检查」随时间刷新。
  useNow();
  const [busy, setBusy] = useState<UpdateAction | null>(null);

  const { update } = status;
  const version = status.version ?? "";
  const api = window.desktopAPI.standalone;

  const run = async (action: UpdateAction, task: () => Promise<void>) => {
    setBusy(action);

    try {
      await task();
    } catch {
      toast.error(t(($) => $.desktop.standalone.prepare.action_failed));
    } finally {
      setBusy(null);
    }
  };

  const installButton = (label: string) => (
    <Button
      size="sm"
      disabled={busy !== null}
      aria-busy={busy === ACTION_INSTALL || undefined}
      onClick={() => void run(ACTION_INSTALL, api.installUpdate)}
    >
      {busy === ACTION_INSTALL && <Loader2 className="animate-spin" aria-hidden />}
      {label}
    </Button>
  );

  switch (update.state) {
    case STANDALONE_UPDATE_AVAILABLE: {
      const meta =
        update.sizeBytes !== null
          ? t(($) => $.desktop.standalone.update.available_meta, { size: approxMegabytes(update.sizeBytes) })
          : t(($) => $.desktop.standalone.update.available_meta_no_size);

      return (
        <UpdateHeader
          title={t(($) => $.desktop.standalone.update.available_title, { version: update.availableVersion ?? "" })}
          meta={meta}
          actions={installButton(t(($) => $.desktop.standalone.update.install))}
        />
      );
    }

    case STANDALONE_UPDATE_DOWNLOADING: {
      const progress = update.progress;
      const percent = progress ? Math.min(PERCENT_MAX, Math.max(0, Math.round(progress.percent))) : 0;
      let meta = "";
      if (progress) {
        const remaining = eta(progress.etaSeconds);
        const values = {
          received: megabytes(progress.receivedBytes),
          total: megabytes(progress.totalBytes),
          speed: megabytes(progress.bytesPerSecond),
        };
        meta = remaining
          ? t(($) => $.desktop.standalone.update.downloading_meta_eta, { ...values, eta: remaining })
          : t(($) => $.desktop.standalone.update.downloading_meta, values);
      }

      return (
        <UpdateHeader title={t(($) => $.desktop.standalone.update.downloading_title)}>
          <div className="flex flex-col gap-1.5 pl-13.5">
            <div
              role="progressbar"
              aria-label={t(($) => $.desktop.standalone.update.progress_label)}
              aria-valuemin={0}
              aria-valuemax={PERCENT_MAX}
              aria-valuenow={percent}
              className="h-1.5 overflow-hidden rounded-full bg-black/8 dark:bg-white/10"
            >
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </div>
            {meta !== "" && <span className="text-caption tabular-nums text-muted-foreground">{meta}</span>}
          </div>
        </UpdateHeader>
      );
    }

    case STANDALONE_UPDATE_INSTALLING:
      return (
        <UpdateHeader
          title={t(($) => $.desktop.standalone.update.installing_title)}
          meta={t(($) => $.desktop.standalone.update.installing_meta)}
        >
          <InstallSteps />
        </UpdateHeader>
      );

    case STANDALONE_UPDATE_ROLLED_BACK:
      return (
        <UpdateHeader
          title={t(($) => $.desktop.standalone.update.rolled_back_title, { version })}
          titleClassName="text-destructive"
          meta={t(($) => $.desktop.standalone.update.rolled_back_meta)}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => void api.openLogs()}>
                {t(($) => $.desktop.standalone.update.view_logs)}
              </Button>
              {installButton(t(($) => $.desktop.standalone.update.retry))}
            </>
          }
        />
      );

    default: {
      const meta =
        update.checkedAt !== null
          ? t(($) => $.desktop.standalone.update.latest_meta, { version, time: timeAgo(update.checkedAt) })
          : t(($) => $.desktop.standalone.update.latest_meta_unchecked, { version });

      return (
        <UpdateHeader
          title={t(($) => $.desktop.standalone.update.latest_title)}
          meta={meta}
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              aria-busy={busy === ACTION_CHECK || undefined}
              onClick={() => void run(ACTION_CHECK, api.checkForUpdate)}
            >
              {busy === ACTION_CHECK && <Loader2 className="animate-spin" aria-hidden />}
              {busy === ACTION_CHECK
                ? t(($) => $.desktop.standalone.update.checking)
                : t(($) => $.desktop.standalone.update.check)}
            </Button>
          }
        />
      );
    }
  }
}

interface UpdateHeaderProps {
  title: string;
  titleClassName?: string;
  meta?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

// 图标 + 标题 + 说明 + 操作，下方可接进度条或步骤。
function UpdateHeader({ title, titleClassName, meta, actions, children }: UpdateHeaderProps) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-foreground">
          <Package className="size-4.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.75">
          <span aria-live="polite" className={cn("text-body font-medium", titleClassName)}>
            {title}
          </span>
          {meta !== undefined && <span className="text-caption text-muted-foreground">{meta}</span>}
        </span>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// 备份数据 → 安装资源 → 更新数据 → 完成。
function InstallSteps() {
  const { t } = useT("settings");

  const steps = [
    t(($) => $.desktop.standalone.update.step_backup),
    t(($) => $.desktop.standalone.update.step_install),
    t(($) => $.desktop.standalone.update.step_migrate),
    t(($) => $.desktop.standalone.update.step_done),
  ];

  return (
    <ol
      aria-label={t(($) => $.desktop.standalone.update.steps_label)}
      className="flex flex-wrap gap-x-5 gap-y-1.5 pl-13.5 text-label"
    >
      {steps.map((label, index) => {
        const current = index === INSTALLING_STEP;
        const past = index < INSTALLING_STEP;

        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5",
              current && "font-medium text-foreground",
              past && "text-foreground",
              !current && !past && "text-faint-foreground",
            )}
          >
            {current && <Loader2 className="size-3.25 animate-spin motion-reduce:animate-none" aria-hidden />}
            {past && <Check className="size-3.25" aria-hidden />}
            {label}
          </li>
        );
      })}
    </ol>
  );
}
