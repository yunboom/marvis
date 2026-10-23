import { useCallback, useEffect, useId, useState } from "react";
import { Loader2, RefreshCw, Server } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@marvis/core/auth";
import { clearClientSessionData } from "@marvis/core/platform";
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
import { cn } from "@marvis/ui/lib/utils";
import { SettingsSection, SettingsTab } from "@marvis/views/settings";
import { useT } from "@marvis/views/i18n";
import {
  DEFAULT_SERVER_ADDRESS,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  normalizeServerAddress,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerIdentity,
  type ServerSource,
} from "../../../../shared/server-discovery";
import { handleDaemonLogout } from "../../platform/desktop-session-teardown";
import { ServerAddressField } from "./server-address-field";
import { useLanServers } from "./use-lan-servers";

const DETAIL_SEPARATOR = " · ";

// 当前服务器的连接状态：打开设置页时探测一次，探测结束前不显示任何状态。
const CONNECTION_CHECKING = "checking";
const CONNECTION_CONNECTED = "connected";
const CONNECTION_OFFLINE = "offline";

type ConnectionState =
  | typeof CONNECTION_CHECKING
  | typeof CONNECTION_CONNECTED
  | typeof CONNECTION_OFFLINE;

// 当前正在使用的服务器。instanceId 为空串表示身份未知（手写预设且还没探测到）。
interface CurrentServer {
  url: string;
  name: string;
  instanceId: string;
}

// 用户点了“切换”、等待确认的目标。address 是对话框里展示的主机和端口。
interface SwitchTarget {
  selected: SelectedServer;
  address: string;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function toSwitchTarget(server: ServerIdentity, source: ServerSource): SwitchTarget {
  return {
    selected: {
      url: server.url,
      name: server.name,
      instanceId: server.instanceId,
      source,
      appUrl: server.appUrl,
    },
    address: hostOf(server.url),
  };
}

// 手写的 ~/.marvis/desktop.json 预设不会写入 server.json，此时当前服务器取自运行配置，
// 主机名作为名称。运行配置不可用（未配置或不合法）时没有可显示的服务器。
function currentFromRuntimeConfig(): CurrentServer | null {
  const result = window.desktopAPI.runtimeConfig;
  if (!result.ok) return null;

  const { apiUrl } = result.config;

  return { url: apiUrl, name: hostOf(apiUrl), instanceId: "" };
}

async function probeServer(url: string): Promise<ProbeResult> {
  try {
    return await window.desktopAPI.server.probe(url);
  } catch {
    // 探测通道本身失败时，对用户而言等同于连不上这个地址。
    return { kind: "unreachable" };
  }
}

function sameAddress(a: string, b: string): boolean {
  return (normalizeServerAddress(a) ?? a) === (normalizeServerAddress(b) ?? b);
}

// 局域网列表里要藏掉当前服务器：身份已知时按实例 ID，否则按地址。
function isCurrentServer(server: DiscoveredServer, current: CurrentServer | null): boolean {
  if (current === null) return false;
  if (current.instanceId !== "") return server.instanceId === current.instanceId;

  return sameAddress(server.url, current.url);
}

function useCurrentServer() {
  const [current, setCurrent] = useState<CurrentServer | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(CONNECTION_CHECKING);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const saved = await window.desktopAPI.server.current();
      const initial = saved ?? currentFromRuntimeConfig();
      if (cancelled || initial === null) return;

      setCurrent(initial);

      const result = await probeServer(initial.url);
      if (cancelled) return;

      if (result.kind !== "ok") {
        setConnection(CONNECTION_OFFLINE);
        return;
      }

      setConnection(CONNECTION_CONNECTED);

      // 预设没有保存过身份：用探测到的名称和实例 ID 补上，列表才能按实例 ID 藏掉它。
      if (saved === null) {
        setCurrent({
          url: initial.url,
          name: result.server.name,
          instanceId: result.server.instanceId,
        });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { current, connection };
}

// 切换服务器前的退出登录：守护进程清理 + 网页会话清理。
function useLogoutBeforeSwitch() {
  const queryClient = useQueryClient();
  const authLogout = useAuthStore((state) => state.logout);

  return useCallback(async () => {
    // 先等守护进程清理完成：随后保存选择会重载所有窗口，没来得及发出的清理就丢了。
    await handleDaemonLogout();

    // 再清掉网页会话（令牌、缓存、本地草稿），与侧边栏的退出登录一致，
    // 否则旧令牌会被带到新服务器。authLogout 会再触发一次壳层的 onLogout，各步骤都是幂等的。
    clearClientSessionData(queryClient);
    authLogout();
  }, [queryClient, authLogout]);
}

// 设置 · 服务器：查看当前服务器，切换到局域网中发现的服务器或手动输入的地址。
export function ServerSettingsTab() {
  const { t } = useT("settings");
  const { current, connection } = useCurrentServer();
  const { servers, scanning, rescan } = useLanServers();
  const logoutBeforeSwitch = useLogoutBeforeSwitch();

  const [address, setAddress] = useState(DEFAULT_SERVER_ADDRESS);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  // 目标在对话框关闭后仍保留，避免关闭动画期间内容消失。
  const [target, setTarget] = useState<SwitchTarget | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const others = servers.filter((server) => !isCurrentServer(server, current));
  const manualTarget = probe?.kind === "ok" ? toSwitchTarget(probe.server, SERVER_SOURCE_MANUAL) : null;
  // 只发现了当前这一台时列表为空，但不能说“没有找到服务器”。
  const nothingFound = !scanning && servers.length === 0;

  const requestSwitch = (next: SwitchTarget) => {
    setTarget(next);
    setConfirmOpen(true);
  };

  const handleOpenChange = (open: boolean) => {
    // 退出登录和保存选择进行中不允许关闭。
    if (!open && switching) return;
    setConfirmOpen(open);
  };

  const handleConfirm = async () => {
    if (target === null) return;

    setSwitching(true);

    try {
      await logoutBeforeSwitch();
      // 保存后主进程会重载所有窗口，页面随即回到登录页。
      await window.desktopAPI.server.select(target.selected);
    } catch (err) {
      setSwitching(false);
      throw err;
    }
  };

  return (
    <SettingsTab
      title={t(($) => $.desktop.server.settings.title)}
      description={t(($) => $.desktop.server.settings.description)}
    >
      {current !== null && <CurrentServerCard current={current} connection={connection} />}

      <SettingsSection
        title={t(($) => $.desktop.server.connect.lan_heading)}
        action={<ScanStatus scanning={scanning} onRescan={rescan} />}
      >
        {others.length > 0 ? (
          <ul className="flex flex-col">
            {others.map((server) => (
              <LanServerRow
                key={server.instanceId || server.url}
                server={server}
                onSwitch={() => requestSwitch(toSwitchTarget(server, SERVER_SOURCE_LAN))}
              />
            ))}
          </ul>
        ) : (
          nothingFound && (
            <p className="px-0.5 text-label leading-relaxed text-muted-foreground">
              {t(($) => $.desktop.server.connect.none)}
            </p>
          )
        )}
      </SettingsSection>

      <SettingsSection title={t(($) => $.desktop.server.settings.other_address)}>
        <ServerAddressField
          variant="plain"
          value={address}
          onChange={setAddress}
          result={probe}
          onResult={setProbe}
          actions={
            <Button
              type="button"
              disabled={manualTarget === null}
              onClick={() => manualTarget !== null && requestSwitch(manualTarget)}
              className="h-10 shrink-0 px-4 text-label"
            >
              {t(($) => $.desktop.server.settings.switch)}
            </Button>
          }
        />
      </SettingsSection>

      <AlertDialog open={confirmOpen} onOpenChange={handleOpenChange}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-105">
          {target !== null && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t(($) => $.desktop.server.settings.switch_title, {
                    name: target.selected.name,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(($) => $.desktop.server.settings.switch_body, {
                    address: target.address,
                  })}
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
    </SettingsTab>
  );
}

interface CurrentServerCardProps {
  current: CurrentServer;
  connection: ConnectionState;
}

// 当前服务器：名称、地址和连接状态。
function CurrentServerCard({ current, connection }: CurrentServerCardProps) {
  const { t } = useT("settings");
  const nameId = useId();

  return (
    <section
      aria-labelledby={nameId}
      className="flex items-center gap-3.5 rounded-xl bg-surface-sunken px-5 py-4.5"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-card text-muted-foreground">
        <Server className="size-5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={nameId} className="truncate text-title-sm font-semibold">
          {current.name}
        </span>
        <span className="truncate font-mono text-label text-muted-foreground">
          {hostOf(current.url)}
        </span>
      </span>
      {connection !== CONNECTION_CHECKING && (
        <span
          className={cn(
            "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-caption",
            connection === CONNECTION_CONNECTED ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.75 rounded-full",
              connection === CONNECTION_CONNECTED ? "bg-success" : "bg-muted-foreground",
            )}
          />
          {connection === CONNECTION_CONNECTED
            ? t(($) => $.desktop.server.settings.connected)
            : t(($) => $.desktop.server.settings.offline)}
        </span>
      )}
    </section>
  );
}

interface ScanStatusProps {
  scanning: boolean;
  onRescan: () => void;
}

// 局域网查找中显示“正在查找”，结束后换成重新查找按钮。
function ScanStatus({ scanning, onRescan }: ScanStatusProps) {
  const { t } = useT("settings");

  if (scanning) {
    return (
      <span
        role="status"
        className="inline-flex h-7 items-center gap-1.5 text-label text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t(($) => $.desktop.server.connect.scanning)}
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      aria-label={t(($) => $.desktop.server.connect.rescan)}
      title={t(($) => $.desktop.server.connect.rescan)}
      onClick={onRescan}
    >
      <RefreshCw className="size-3.5" aria-hidden />
    </Button>
  );
}

interface LanServerRowProps {
  server: DiscoveredServer;
  onSwitch: () => void;
}

function LanServerRow({ server, onSwitch }: LanServerRowProps) {
  const { t } = useT("settings");
  const nameId = useId();

  const detail = [
    hostOf(server.url),
    server.version,
    server.compatible ? "" : t(($) => $.desktop.server.probe.too_old),
  ]
    .filter((part) => part !== "")
    .join(DETAIL_SEPARATOR);

  return (
    <li className="flex min-h-14 items-center gap-3 border-t border-surface-border py-2 pr-2 pl-1 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.75">
        <span id={nameId} className="truncate text-body font-medium">
          {server.name}
        </span>
        <span className="truncate text-caption text-muted-foreground">{detail}</span>
      </span>
      {/* 同样的“切换”按钮有多个，服务器名称作为描述帮助辅助技术区分。 */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!server.compatible}
        aria-describedby={nameId}
        onClick={onSwitch}
        className="px-3.5"
      >
        {t(($) => $.desktop.server.settings.switch)}
      </Button>
    </li>
  );
}
