import { useId, useState } from "react";
import { Loader2, RefreshCw, Server, Wifi, WifiOff } from "lucide-react";
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
import { DragStrip } from "@marvis/views/platform";
import {
  DEFAULT_SERVER_ADDRESS,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
} from "../../../../shared/server-discovery";
import { ServerAddressField } from "./server-address-field";
import { useLanServers } from "./use-lan-servers";

const DETAIL_SEPARATOR = " · ";

const PRIMARY_BUTTON_CLASS = "h-12 w-full text-body-lg";

// 用户在选择步骤里明确点选过的项；null 表示还没有操作，走默认选中。
type UserPick = { kind: typeof SERVER_SOURCE_LAN; url: string } | { kind: typeof SERVER_SOURCE_MANUAL };

// 当前生效的选中项：局域网中的某个服务器、手动输入的地址，或暂时没有。
type Selection =
  | { kind: typeof SERVER_SOURCE_LAN; server: DiscoveredServer }
  | { kind: typeof SERVER_SOURCE_MANUAL }
  | { kind: "none" };

// 点“连接”时落盘的服务器，以及左栏摘要要展示的版本。
interface ConnectTarget {
  selected: SelectedServer;
  version: string;
}

function resolveSelection(
  pick: UserPick | null,
  servers: DiscoveredServer[],
  scanning: boolean,
): Selection {
  if (pick?.kind === SERVER_SOURCE_MANUAL) return { kind: SERVER_SOURCE_MANUAL };

  const usable = servers.filter((server) => server.compatible);
  if (pick?.kind === SERVER_SOURCE_LAN) {
    const picked = usable.find((server) => server.url === pick.url);
    if (picked) return { kind: SERVER_SOURCE_LAN, server: picked };
  }

  // 默认选中第一个可用的服务器；查找结束仍没有可用的，地址栏自动成为选中项。
  if (usable.length > 0) return { kind: SERVER_SOURCE_LAN, server: usable[0]! };
  if (!scanning) return { kind: SERVER_SOURCE_MANUAL };

  return { kind: "none" };
}

function toConnectTarget(
  selection: Selection,
  probe: ProbeResult | null,
): ConnectTarget | null {
  if (selection.kind === SERVER_SOURCE_LAN) {
    const { server } = selection;

    return {
      selected: {
        url: server.url,
        name: server.name,
        instanceId: server.instanceId,
        source: SERVER_SOURCE_LAN,
        appUrl: server.appUrl,
      },
      version: server.version,
    };
  }

  if (selection.kind === SERVER_SOURCE_MANUAL && probe?.kind === "ok") {
    const { server } = probe;

    return {
      selected: {
        url: server.url,
        name: server.name,
        instanceId: server.instanceId,
        source: SERVER_SOURCE_MANUAL,
        appUrl: server.appUrl,
      },
      version: server.version,
    };
  }

  return null;
}

// 选中项在左栏摘要里的一行：名称 + 地址 · 版本。
function serverSummaryLine(url: string, version: string): string {
  return [new URL(url).host, version].filter((part) => part !== "").join(DETAIL_SEPARATOR);
}

// 桌面端首次启动（还没有选择服务器）时的连接页：选好服务器后点“连接”直接保存并重载。
// 两栏布局与引导页一致：左栏标题、已选服务器摘要和按钮，右栏是服务器列表和地址栏。
export function ConnectServerScreen({
  suggestedAddress,
}: {
  /** 预填进地址栏的地址（开发模式下的本地后端）；缺省用默认地址。 */
  suggestedAddress?: string;
}) {
  const { t } = useT("settings");
  const [pick, setPick] = useState<UserPick | null>(null);
  const [address, setAddress] = useState(suggestedAddress ?? DEFAULT_SERVER_ADDRESS);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  const { servers, scanning, rescan } = useLanServers();

  const selection = resolveSelection(pick, servers, scanning);
  const noneFound = !scanning && servers.length === 0;

  let connectDisabled: boolean;
  if (selection.kind === SERVER_SOURCE_LAN) {
    // 查找窗口内默认选中的项还可能变化，用户明确点选过才能连接。
    connectDisabled = scanning && pick === null;
  } else if (selection.kind === SERVER_SOURCE_MANUAL) {
    connectDisabled = probe?.kind !== "ok";
  } else {
    connectDisabled = true;
  }

  const summaryTarget = toConnectTarget(selection, probe);
  let summary: { name: string; line: string; picked: boolean };
  if (summaryTarget) {
    summary = {
      name: summaryTarget.selected.name,
      line: serverSummaryLine(summaryTarget.selected.url, summaryTarget.version),
      picked: true,
    };
  } else if (selection.kind === SERVER_SOURCE_MANUAL) {
    summary = {
      name: t(($) => $.desktop.server.connect.summary_manual),
      line: t(($) => $.desktop.server.connect.summary_manual_hint),
      picked: false,
    };
  } else {
    summary = {
      name: t(($) => $.desktop.server.connect.summary_scanning),
      line: t(($) => $.desktop.server.connect.summary_scanning_hint),
      picked: false,
    };
  }

  const handleConnect = async () => {
    if (!summaryTarget) return;

    setConnecting(true);
    try {
      // 保存后主进程会重载所有窗口，页面随即回到登录页。
      await window.desktopAPI.server.select(summaryTarget.selected);
    } catch (err) {
      setConnecting(false);
      throw err;
    }
  };

  const subtitle = noneFound
    ? t(($) => $.desktop.server.connect.subtitle_none)
    : t(($) => $.desktop.server.connect.subtitle);

  return (
    <div className="flex h-screen flex-col bg-app-shell text-foreground">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center overflow-auto px-4 py-8">
        <SplitCard>
          <SplitCardIntro>
            <MarvisIcon className="size-9 text-foreground" />

            <h1 className="mt-8 text-display-sm font-bold [@media(max-height:760px)]:mt-5">{t(($) => $.desktop.server.connect.title)}</h1>
            <p className="mt-3 text-body leading-relaxed text-muted-foreground">{subtitle}</p>

            <div className="mt-7 flex items-center gap-3 rounded-2xl bg-surface-sunken px-3.5 py-3 [@media(max-height:760px)]:mt-5">
              <span
                aria-hidden
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-[10px] text-background",
                  summary.picked ? "bg-foreground" : "bg-input",
                )}
              >
                <Server className="size-4.5" />
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "truncate text-body font-semibold",
                    !summary.picked && "text-faint-foreground",
                  )}
                >
                  {summary.name}
                </p>
                <p aria-live="polite" className="truncate text-caption text-muted-foreground">
                  {summary.line}
                </p>
              </div>
            </div>
          </SplitCardIntro>

          <SplitCardPane>
            <div className="flex min-h-[320px] flex-1 flex-col overflow-y-auto rounded-[20px] bg-surface-sunken md:min-h-0">
              <PickPane
                servers={servers}
                scanning={scanning}
                noneFound={noneFound}
                selection={selection}
                address={address}
                probe={probe}
                onRescan={rescan}
                onPickServer={(server) => setPick({ kind: SERVER_SOURCE_LAN, url: server.url })}
                onPickAddress={() => setPick({ kind: SERVER_SOURCE_MANUAL })}
                onAddressChange={setAddress}
                onProbeResult={setProbe}
              />
            </div>
          </SplitCardPane>

          <SplitCardActions>
            <Button
              size="lg"
              className={PRIMARY_BUTTON_CLASS}
              disabled={connectDisabled || connecting}
              onClick={() => void handleConnect()}
            >
              {connecting && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {connecting
                ? t(($) => $.desktop.server.confirm.connecting)
                : t(($) => $.desktop.server.confirm.connect)}
            </Button>
          </SplitCardActions>
        </SplitCard>
      </div>
    </div>
  );
}

interface PickPaneProps {
  servers: DiscoveredServer[];
  scanning: boolean;
  noneFound: boolean;
  selection: Selection;
  address: string;
  probe: ProbeResult | null;
  onRescan: () => void;
  onPickServer: (server: DiscoveredServer) => void;
  onPickAddress: () => void;
  onAddressChange: (value: string) => void;
  onProbeResult: (result: ProbeResult | null) => void;
}

function PickPane({
  servers,
  scanning,
  noneFound,
  selection,
  address,
  probe,
  onRescan,
  onPickServer,
  onPickAddress,
  onAddressChange,
  onProbeResult,
}: PickPaneProps) {
  const { t } = useT("settings");
  const headingId = useId();

  return (
    <div className="flex flex-col p-2">
      {noneFound ? (
        <div role="status" className="flex items-start gap-3 px-3 pt-3 pb-4">
          <WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1 text-label leading-relaxed text-muted-foreground">
            {t(($) => $.desktop.server.connect.none)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 bg-surface"
            onClick={onRescan}
          >
            {t(($) => $.desktop.server.connect.rescan)}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex h-9 items-center gap-2 px-2.5 text-caption text-muted-foreground">
            <Wifi className="size-3.5" aria-hidden />
            <span id={headingId} className="font-semibold text-foreground">
              {t(($) => $.desktop.server.connect.lan_heading)}
            </span>
            {scanning ? (
              <span role="status" className="ml-auto inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {t(($) => $.desktop.server.connect.scanning)}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6.5 gap-1 px-2 text-caption font-normal text-muted-foreground"
                onClick={onRescan}
              >
                <RefreshCw className="size-3" aria-hidden />
                {t(($) => $.desktop.server.connect.rescan)}
              </Button>
            )}
          </div>

          <div role="radiogroup" aria-labelledby={headingId} className="flex flex-col gap-0.5">
            {servers.map((server) => (
              <ServerRow
                key={server.instanceId || server.url}
                server={server}
                checked={selection.kind === SERVER_SOURCE_LAN && selection.server.url === server.url}
                onPick={() => onPickServer(server)}
              />
            ))}
            {scanning && servers.length === 0 && <ScanningPlaceholder />}
          </div>

          <div aria-hidden className="mx-2.5 mt-2.5 mb-1 flex items-center gap-2.5 text-caption text-faint-foreground">
            <span className="h-px flex-1 bg-surface-border" />
            {t(($) => $.desktop.server.connect.or_address)}
            <span className="h-px flex-1 bg-surface-border" />
          </div>
        </>
      )}

      <ServerAddressField
        variant="pane"
        value={address}
        onChange={onAddressChange}
        result={probe}
        onResult={onProbeResult}
        selected={selection.kind === SERVER_SOURCE_MANUAL}
        onSelect={onPickAddress}
      />
    </div>
  );
}

interface ServerRowProps {
  server: DiscoveredServer;
  checked: boolean;
  onPick: () => void;
}

// 一台服务器一行：选中行白底墨色描边，与运行时列表一致。
function ServerRow({ server, checked, onPick }: ServerRowProps) {
  const { t } = useT("settings");

  const detail = [
    new URL(server.url).host,
    server.version,
    server.compatible ? "" : t(($) => $.desktop.server.probe.too_old),
  ]
    .filter((part) => part !== "")
    .join(DETAIL_SEPARATOR);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={!server.compatible}
      onClick={onPick}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-[14px] py-2 pr-3.5 pl-2.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-surface shadow-[0_0_0_1.5px_var(--color-foreground)]"
          : "hover:bg-surface/60",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface text-muted-foreground ring-1 ring-surface-border">
        <Server className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-body font-medium">
          <span className="truncate">{server.name}</span>
          {server.isLocal && (
            <span className="shrink-0 text-caption font-normal text-faint-foreground">
              {t(($) => $.desktop.server.connect.local_badge)}
            </span>
          )}
        </span>
        <span className="truncate text-caption text-faint-foreground">{detail}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex size-4.5 shrink-0 items-center justify-center rounded-full",
          checked ? "bg-foreground" : "border-[1.5px] border-input",
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-background" />}
      </span>
    </button>
  );
}

// 还没有任何服务器出现时的占位行。
function ScanningPlaceholder() {
  return (
    <div aria-hidden className="flex h-14 animate-pulse items-center gap-3 px-2.5">
      <span className="size-8 rounded-[9px] bg-skeleton" />
      <span className="flex flex-col gap-1.5">
        <span className="h-2.5 w-30 rounded-full bg-skeleton" />
        <span className="h-2 w-45 rounded-full bg-skeleton" />
      </span>
    </div>
  );
}
