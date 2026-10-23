import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Laptop, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { Switch } from "@marvis/ui/components/ui/switch";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "@marvis/views/i18n";
import { AppLink, useNavigation } from "@marvis/views/navigation";
import { SettingsSection, SettingsTab } from "@marvis/views/settings";
import {
  SERVER_SOURCE_MANUAL,
  type ProbeResult,
  type SelectedServer,
} from "../../../../shared/server-discovery";
import {
  STANDALONE_PHASE_DOWNLOADING,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_RUNNING,
  STANDALONE_PHASE_STARTING,
  STANDALONE_PHASE_STOPPED,
  STANDALONE_PHASE_VERIFYING,
  STANDALONE_UPDATE_INSTALLING,
  type StandaloneBackup,
  type StandaloneConfigView,
  type StandaloneStatus,
} from "../../../../shared/standalone";
import { ServerAddressField } from "../server/server-address-field";
import { useLogoutBeforeSwitch } from "../server/use-logout-before-switch";
import { StandaloneConfigDialog } from "./standalone-config-dialog";
import { formatBackupSize, useBackupDate, useNow, useRunningDuration } from "./standalone-format";
import { DATA_LOCATION } from "./standalone-setup-screen";
import { InfoTip } from "./standalone-setup-form";
import { useStandaloneStatus } from "./use-standalone-status";

const UPDATES_TAB = "updates";
const BACKUP_REASON_UPDATE = "update";

// 状态卡片右上角的状态。
const STATE_RUNNING = "running";
const STATE_STARTING = "starting";
const STATE_STOPPED = "stopped";
const STATE_UNAVAILABLE = "unavailable";
const STATE_UPDATING = "updating";

type RunState =
  | typeof STATE_RUNNING
  | typeof STATE_STARTING
  | typeof STATE_STOPPED
  | typeof STATE_UNAVAILABLE
  | typeof STATE_UPDATING;

const STARTING_PHASES = new Set<string>([
  STANDALONE_PHASE_STARTING,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_VERIFYING,
  STANDALONE_PHASE_DOWNLOADING,
]);

// 状态卡片上可能同时进行的操作。
const ACTION_RESTART = "restart";
const ACTION_STOP = "stop";
const ACTION_START = "start";

type CardAction = typeof ACTION_RESTART | typeof ACTION_STOP | typeof ACTION_START;

export function resolveRunState(status: StandaloneStatus): RunState {
  if (status.update.state === STANDALONE_UPDATE_INSTALLING) return STATE_UPDATING;
  if (status.phase === STANDALONE_PHASE_RUNNING) return STATE_RUNNING;
  if (STARTING_PHASES.has(status.phase)) return STATE_STARTING;
  if (status.phase === STANDALONE_PHASE_STOPPED) return STATE_STOPPED;

  return STATE_UNAVAILABLE;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

// 读取当前配置；reload 在保存或切换局域网后重新读取。
function useStandaloneConfig(): [StandaloneConfigView | null, () => void] {
  const [config, setConfig] = useState<StandaloneConfigView | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void window.desktopAPI.standalone.config().then((next) => {
      if (!cancelled) setConfig(next);
    });

    return () => {
      cancelled = true;
    };
  }, [version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  return [config, reload];
}

// 设置 · 服务器（单机模式）：运行状态、局域网连接、切换到其他服务器、配置与数据。
export function StandaloneServerSettings() {
  const { t } = useT("settings");
  const status = useStandaloneStatus();
  const [config, reloadConfig] = useStandaloneConfig();

  return (
    <SettingsTab
      title={t(($) => $.desktop.server.settings.title)}
      description={t(($) => $.desktop.standalone.settings.description)}
    >
      {status !== null && config !== null && (
        <StatusCard status={status} config={config} onLanChanged={reloadConfig} />
      )}

      <UpdatesLinkRow />

      <SwitchRemoteSection />

      <div className="grid grid-cols-1 gap-7 md:grid-cols-2 md:gap-4">
        {config !== null && <ConfigSection config={config} onSaved={reloadConfig} />}
        <DataSection />
      </div>
    </SettingsTab>
  );
}

interface StatusCardProps {
  status: StandaloneStatus;
  config: StandaloneConfigView;
  onLanChanged: () => void;
}

// 名称、资源版本与运行时长、状态和操作，下方是「允许局域网连接」。
function StatusCard({ status, config, onLanChanged }: StatusCardProps) {
  const { t } = useT("settings");
  const nameId = useId();
  const now = useNow();
  const runningFor = useRunningDuration();
  const [busy, setBusy] = useState<CardAction | null>(null);

  const state = resolveRunState(status);
  const running = state === STATE_RUNNING;
  const canStop = running || state === STATE_STARTING;
  const updating = state === STATE_UPDATING;
  const api = window.desktopAPI.standalone;

  let meta = "";
  if (status.version !== null) {
    meta =
      running && status.startedAt !== null
        ? t(($) => $.desktop.standalone.settings.meta_running, {
            version: status.version,
            duration: runningFor(status.startedAt, now),
          })
        : t(($) => $.desktop.standalone.settings.meta, { version: status.version });
  }

  const run = async (action: CardAction, task: () => Promise<void>) => {
    setBusy(action);

    try {
      await task();
    } catch {
      toast.error(t(($) => $.desktop.standalone.prepare.action_failed));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={nameId} className="flex flex-col rounded-xl bg-surface-sunken">
      <div className="flex flex-wrap items-center gap-3.5 px-5 py-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-card text-foreground">
          <Laptop className="size-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span id={nameId} className="truncate text-title-sm font-semibold">
              {config.settings.name}
            </span>
            <span className="shrink-0 text-caption text-faint-foreground">
              {t(($) => $.desktop.standalone.settings.mode)}
            </span>
          </span>
          {meta !== "" && <span className="truncate text-label text-muted-foreground">{meta}</span>}
        </span>
        <StatePill state={state} />
        <Button
          variant="outline"
          size="sm"
          className="bg-card"
          disabled={!running || busy !== null}
          aria-busy={busy === ACTION_RESTART || undefined}
          onClick={() => void run(ACTION_RESTART, api.restart)}
        >
          {busy === ACTION_RESTART && <Loader2 className="animate-spin" aria-hidden />}
          {t(($) => $.desktop.standalone.settings.reload)}
        </Button>
        {canStop ? (
          <Button
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={busy !== null}
            aria-busy={busy === ACTION_STOP || undefined}
            onClick={() => void run(ACTION_STOP, api.stop)}
          >
            {busy === ACTION_STOP && <Loader2 className="animate-spin" aria-hidden />}
            {t(($) => $.desktop.standalone.settings.stop)}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={updating || busy !== null}
            aria-busy={busy === ACTION_START || undefined}
            onClick={() => void run(ACTION_START, api.retry)}
          >
            {busy === ACTION_START && <Loader2 className="animate-spin" aria-hidden />}
            {t(($) => $.desktop.standalone.settings.start)}
          </Button>
        )}
      </div>

      <LanRow enabled={config.settings.lanEnabled} lanUrl={status.lanUrl} onChanged={onLanChanged} />
    </section>
  );
}

function StatePill({ state }: { state: RunState }) {
  const { t } = useT("settings");

  const labels: Record<RunState, string> = {
    [STATE_RUNNING]: t(($) => $.desktop.standalone.settings.status.running),
    [STATE_STARTING]: t(($) => $.desktop.standalone.settings.status.starting),
    [STATE_STOPPED]: t(($) => $.desktop.standalone.settings.status.stopped),
    [STATE_UNAVAILABLE]: t(($) => $.desktop.standalone.settings.status.unavailable),
    [STATE_UPDATING]: t(($) => $.desktop.standalone.settings.status.updating),
  };
  const dots: Record<RunState, string> = {
    [STATE_RUNNING]: "bg-success",
    [STATE_STARTING]: "bg-warning",
    [STATE_STOPPED]: "bg-muted-foreground",
    [STATE_UNAVAILABLE]: "bg-destructive",
    [STATE_UPDATING]: "bg-warning",
  };

  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-caption",
        state === STATE_STOPPED ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <span aria-hidden className={cn("size-1.75 rounded-full", dots[state])} />
      {labels[state]}
    </span>
  );
}

interface LanRowProps {
  enabled: boolean;
  lanUrl: string | null;
  onChanged: () => void;
}

// 「允许局域网连接」：切换后单机模式重新加载，期间开关不可用。开着且有地址时，ⓘ 里给出手动输入的地址。
function LanRow({ enabled, lanUrl, onChanged }: LanRowProps) {
  const { t } = useT("settings");
  const labelId = useId();
  // 切换进行中显示目标值。
  const [pending, setPending] = useState<boolean | null>(null);

  const checked = pending ?? enabled;
  const label = t(($) => $.desktop.standalone.settings.lan_label);

  const handleChange = async (next: boolean) => {
    setPending(next);

    try {
      await window.desktopAPI.standalone.setLan(next);
      onChanged();
    } catch {
      toast.error(t(($) => $.desktop.standalone.prepare.action_failed));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex min-h-12 items-center gap-3 border-t border-surface-border px-5 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span id={labelId} className="text-body">
          {label}
        </span>
        {checked && lanUrl !== null && (
          <InfoTip label={label} help={t(($) => $.desktop.standalone.settings.lan_help, { url: lanUrl })} />
        )}
      </span>
      {pending !== null && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
      <Switch
        aria-labelledby={labelId}
        aria-busy={pending !== null || undefined}
        checked={checked}
        disabled={pending !== null}
        onCheckedChange={(next) => void handleChange(next)}
      />
    </div>
  );
}

// 「资源更新」：检查与安装在 设置 › 更新。
function UpdatesLinkRow() {
  const { t } = useT("settings");
  const navigation = useNavigation();

  const params = new URLSearchParams(navigation.searchParams);
  params.set("tab", UPDATES_TAB);
  params.delete("section");
  params.delete("integration");
  const href = `${navigation.pathname}?${params.toString()}`;

  return (
    <div className="flex min-h-12 items-center gap-3 rounded-xl px-5 py-2 ring-1 ring-surface-border">
      <span className="flex-1 text-body">{t(($) => $.desktop.standalone.settings.updates_label)}</span>
      <span className="text-label text-muted-foreground">{t(($) => $.desktop.standalone.settings.updates_hint)}</span>
      <AppLink href={href} className="text-label text-foreground underline underline-offset-4">
        {t(($) => $.desktop.standalone.settings.updates_go)}
      </AppLink>
    </div>
  );
}

// 「切换到其他服务器」：测试连接通过后才能切换，确认后退出登录并停止单机模式。
function SwitchRemoteSection() {
  const { t } = useT("settings");
  const logoutBeforeSwitch = useLogoutBeforeSwitch();
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  // 目标在对话框关闭后仍保留，避免关闭动画期间内容消失。
  const [target, setTarget] = useState<SelectedServer | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const probed: SelectedServer | null =
    probe?.kind === "ok"
      ? {
          url: probe.server.url,
          name: probe.server.name,
          instanceId: probe.server.instanceId,
          source: SERVER_SOURCE_MANUAL,
          appUrl: probe.server.appUrl,
        }
      : null;

  const handleOpenChange = (open: boolean) => {
    // 退出登录和切换进行中不允许关闭。
    if (!open && switching) return;
    setConfirmOpen(open);
  };

  const handleConfirm = async () => {
    if (target === null) return;

    setSwitching(true);

    try {
      await logoutBeforeSwitch();
      // 切换后主进程会重载所有窗口，页面随即回到登录页。
      await window.desktopAPI.standalone.switchRemote(target);
    } catch {
      // 退出登录会卸载设置页，失败提示走全局 toast。
      toast.error(t(($) => $.desktop.server.settings.switch_failed));
      setSwitching(false);
    }
  };

  return (
    <SettingsSection title={t(($) => $.desktop.standalone.settings.switch_heading)}>
      <ServerAddressField
        variant="plain"
        value={address}
        onChange={setAddress}
        result={probe}
        onResult={setProbe}
        actions={
          <Button
            type="button"
            disabled={probed === null}
            onClick={() => {
              if (probed === null) return;
              setTarget(probed);
              setConfirmOpen(true);
            }}
            className="h-10 shrink-0 px-4 text-label"
          >
            {t(($) => $.desktop.server.settings.switch)}
          </Button>
        }
      />
      <p className="px-1 text-caption text-muted-foreground">{t(($) => $.desktop.standalone.settings.switch_hint)}</p>

      <AlertDialog open={confirmOpen} onOpenChange={handleOpenChange}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-110">
          {target !== null && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t(($) => $.desktop.standalone.settings.switch_title, { name: target.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(($) => $.desktop.standalone.settings.switch_body, { host: hostOf(target.url) })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel variant="secondary" disabled={switching}>
                  {t(($) => $.desktop.server.settings.cancel)}
                </AlertDialogCancel>
                <AlertDialogAction disabled={switching} onClick={() => void handleConfirm()}>
                  {switching && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  {t(($) => $.desktop.server.settings.switch)}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

interface ConfigSectionProps {
  config: StandaloneConfigView;
  onSaved: () => void;
}

// 「配置」：只读摘要，编辑在弹窗里。
function ConfigSection({ config, onSaved }: ConfigSectionProps) {
  const { t } = useT("settings");
  const [editing, setEditing] = useState(false);
  const { settings } = config;

  const configured = t(($) => $.desktop.standalone.form.configured);
  const notConfigured = t(($) => $.desktop.standalone.form.not_configured);
  const larkOn = settings.lark.appId.trim() !== "";
  const smtpOn = settings.smtp.host.trim() !== "";

  return (
    <SettingsSection
      title={t(($) => $.desktop.standalone.settings.config_heading)}
      action={
        <Button variant="outline" size="xs" onClick={() => setEditing(true)}>
          {t(($) => $.desktop.standalone.settings.edit)}
        </Button>
      }
    >
      <SummaryList>
        <SummaryRow term={t(($) => $.desktop.standalone.settings.port)}>
          <span className="font-mono tabular-nums">{settings.port}</span>
        </SummaryRow>
        <SummaryRow term={t(($) => $.desktop.standalone.settings.admin_email)}>
          <span className="truncate">{settings.adminEmail}</span>
        </SummaryRow>
        <SummaryRow term={t(($) => $.desktop.standalone.settings.lark)} muted={!larkOn}>
          {larkOn ? configured : notConfigured}
        </SummaryRow>
        <SummaryRow term={t(($) => $.desktop.standalone.settings.smtp)} muted={!smtpOn}>
          {smtpOn ? configured : notConfigured}
        </SummaryRow>
        <SummaryRow term={t(($) => $.desktop.standalone.settings.keys)} muted>
          {config.locked
            ? t(($) => $.desktop.standalone.settings.keys_locked)
            : t(($) => $.desktop.standalone.settings.keys_unlocked)}
        </SummaryRow>
      </SummaryList>

      <StandaloneConfigDialog
        open={editing}
        onOpenChange={setEditing}
        config={config}
        onSaved={() => {
          setEditing(false);
          onSaved();
        }}
      />
    </SettingsSection>
  );
}

// 「数据」：数据文件夹、备份与恢复、日志。
function DataSection() {
  const { t } = useT("settings");
  const backupDate = useBackupDate();
  const [backups, setBackups] = useState<StandaloneBackup[]>([]);
  const [backingUp, setBackingUp] = useState(false);
  // 恢复的目标在对话框关闭后仍保留，避免关闭动画期间内容消失。
  const [target, setTarget] = useState<StandaloneBackup | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const api = window.desktopAPI.standalone;

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await window.desktopAPI.standalone.listBackups());
    } catch {
      // 读不到列表时保持原样，备份与恢复仍可从「打开」的文件夹里查看。
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const actionFailed = () => toast.error(t(($) => $.desktop.standalone.prepare.action_failed));

  const handleBackup = async () => {
    setBackingUp(true);

    try {
      await api.backupNow();
      await loadBackups();
    } catch {
      actionFailed();
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async () => {
    if (target === null) return;

    setRestoring(true);

    try {
      await api.restoreBackup(target.fileName);
      setConfirmOpen(false);
      await loadBackups();
    } catch {
      actionFailed();
    } finally {
      setRestoring(false);
    }
  };

  const open = (task: () => Promise<void>) => {
    task().catch(actionFailed);
  };

  const location = DATA_LOCATION[window.desktopAPI.appInfo.os] ?? DATA_LOCATION.macos;

  return (
    <SettingsSection
      title={t(($) => $.desktop.standalone.settings.data_heading)}
      action={
        <Button
          variant="outline"
          size="xs"
          disabled={backingUp}
          aria-busy={backingUp || undefined}
          onClick={() => void handleBackup()}
        >
          {backingUp && <Loader2 className="animate-spin" aria-hidden />}
          {t(($) => $.desktop.standalone.settings.backup_now)}
        </Button>
      }
    >
      <SummaryList footer={t(($) => $.desktop.standalone.settings.keep_hint)}>
        <SummaryRow
          term={<span className="font-mono text-caption">{location}</span>}
          action={
            <RowAction onClick={() => open(api.openDataDir)}>{t(($) => $.desktop.standalone.settings.open)}</RowAction>
          }
        />
        {backups.map((backup) => {
          const date = backupDate(backup.createdAt);

          return (
            <SummaryRow
              key={backup.fileName}
              term={
                backup.reason === BACKUP_REASON_UPDATE
                  ? t(($) => $.desktop.standalone.settings.backup_update, { date })
                  : t(($) => $.desktop.standalone.settings.backup_manual, { date })
              }
              action={
                <RowAction
                  onClick={() => {
                    setTarget(backup);
                    setConfirmOpen(true);
                  }}
                >
                  {t(($) => $.desktop.standalone.settings.restore)}
                </RowAction>
              }
            >
              <span className="tabular-nums">{formatBackupSize(backup.sizeBytes)}</span>
            </SummaryRow>
          );
        })}
        <SummaryRow
          term={t(($) => $.desktop.standalone.settings.logs)}
          action={<RowAction onClick={() => open(api.openLogs)}>{t(($) => $.desktop.standalone.settings.view)}</RowAction>}
        />
      </SummaryList>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next && restoring) return;
          setConfirmOpen(next);
        }}
      >
        <AlertDialogContent className="data-[size=default]:sm:max-w-105">
          {target !== null && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t(($) => $.desktop.standalone.settings.restore_title, { date: backupDate(target.createdAt) })}
                </AlertDialogTitle>
                <AlertDialogDescription>{t(($) => $.desktop.standalone.settings.restore_body)}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel variant="secondary" disabled={restoring}>
                  {t(($) => $.desktop.server.settings.cancel)}
                </AlertDialogCancel>
                <AlertDialogAction disabled={restoring} onClick={() => void handleRestore()}>
                  {restoring && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  {t(($) => $.desktop.standalone.settings.restore)}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function SummaryList({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl px-4 py-1 ring-1 ring-surface-border">
      <dl className="flex flex-col">{children}</dl>
      {footer !== undefined && (
        <p className="flex min-h-10 items-center border-t border-surface-border text-label text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}

interface SummaryRowProps {
  term: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  muted?: boolean;
}

function SummaryRow({ term, children, action, muted = false }: SummaryRowProps) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-t border-surface-border text-label first:border-t-0">
      <dt className="min-w-0 flex-1 truncate text-muted-foreground">{term}</dt>
      {children !== undefined && (
        <dd className={cn("flex min-w-0 justify-end", muted ? "text-faint-foreground" : "text-foreground")}>
          {children}
        </dd>
      )}
      {action !== undefined && <dd className="shrink-0">{action}</dd>}
    </div>
  );
}

function RowAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-sm text-label text-foreground underline underline-offset-4 outline-none hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </button>
  );
}
