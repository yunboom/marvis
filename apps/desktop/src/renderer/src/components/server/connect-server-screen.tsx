import { useId, useState } from "react";
import { Loader2, RefreshCw, Server, TriangleAlert, WifiOff } from "lucide-react";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { Button } from "@marvis/ui/components/ui/button";
import { Card } from "@marvis/ui/components/ui/card";
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

const HTTP_PROTOCOL = "http:";
const DETAIL_SEPARATOR = " · ";

// 卡片 480 宽、24 圆角；投影与登录页一致，暗色去掉投影只留描边。
const CARD_CLASS =
  "w-full max-w-120 gap-0 rounded-2xl border-0 p-8 pb-7 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border dark:shadow-none";
const TITLE_CLASS = "mt-4.5 text-center text-display-sm font-bold";
const SUBTITLE_CLASS = "mt-2 text-center text-body text-muted-foreground";
const PRIMARY_BUTTON_CLASS = "h-12 text-body-lg";

// 用户在选择步骤里明确点选过的项；null 表示还没有操作，走默认选中。
type UserPick = { kind: typeof SERVER_SOURCE_LAN; url: string } | { kind: typeof SERVER_SOURCE_MANUAL };

// 当前生效的选中项：局域网中的某个服务器、手动输入的地址，或暂时没有。
type Selection =
  | { kind: typeof SERVER_SOURCE_LAN; server: DiscoveredServer }
  | { kind: typeof SERVER_SOURCE_MANUAL }
  | { kind: "none" };

// 确认步骤要展示、并在“连接”时落盘的服务器。
interface ConnectTarget {
  selected: SelectedServer;
  version: string;
  host: string;
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
      host: server.host,
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
      host: server.host,
    };
  }

  return null;
}

// 桌面端首次启动（还没有选择服务器）时的连接页：先选服务器，再确认，最后保存并重载。
export function ConnectServerScreen() {
  const [target, setTarget] = useState<ConnectTarget | null>(null);
  const [pick, setPick] = useState<UserPick | null>(null);
  const [address, setAddress] = useState(DEFAULT_SERVER_ADDRESS);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const { servers, scanning, rescan } = useLanServers();

  const selection = resolveSelection(pick, servers, scanning);

  return (
    <div className="flex h-screen flex-col bg-app-shell text-foreground">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center overflow-auto px-4 pb-12">
        <Card className={CARD_CLASS}>
          <MarvisIcon className="mx-auto size-11 text-foreground" />
          {target ? (
            <ConfirmStep target={target} onBack={() => setTarget(null)} />
          ) : (
            <PickStep
              servers={servers}
              scanning={scanning}
              selection={selection}
              explicit={pick !== null}
              address={address}
              probe={probe}
              onRescan={rescan}
              onPickServer={(server) => setPick({ kind: SERVER_SOURCE_LAN, url: server.url })}
              onPickAddress={() => setPick({ kind: SERVER_SOURCE_MANUAL })}
              onAddressChange={setAddress}
              onProbeResult={setProbe}
              onContinue={() => setTarget(toConnectTarget(selection, probe))}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

interface PickStepProps {
  servers: DiscoveredServer[];
  scanning: boolean;
  selection: Selection;
  /** 用户是否明确点选过；查找窗口内默认选中的项还可能变化，需要等查找结束。 */
  explicit: boolean;
  address: string;
  probe: ProbeResult | null;
  onRescan: () => void;
  onPickServer: (server: DiscoveredServer) => void;
  onPickAddress: () => void;
  onAddressChange: (value: string) => void;
  onProbeResult: (result: ProbeResult | null) => void;
  onContinue: () => void;
}

function PickStep({
  servers,
  scanning,
  selection,
  explicit,
  address,
  probe,
  onRescan,
  onPickServer,
  onPickAddress,
  onAddressChange,
  onProbeResult,
  onContinue,
}: PickStepProps) {
  const { t } = useT("settings");
  const headingId = useId();

  const noneFound = !scanning && servers.length === 0;
  const manualSelected = selection.kind === SERVER_SOURCE_MANUAL;

  let continueDisabled: boolean;
  if (selection.kind === SERVER_SOURCE_LAN) {
    continueDisabled = scanning && !explicit;
  } else if (selection.kind === SERVER_SOURCE_MANUAL) {
    continueDisabled = probe?.kind !== "ok";
  } else {
    continueDisabled = true;
  }

  return (
    <>
      <h1 className={TITLE_CLASS}>{t(($) => $.desktop.server.connect.title)}</h1>
      <p className={SUBTITLE_CLASS}>
        {noneFound
          ? t(($) => $.desktop.server.connect.subtitle_none)
          : t(($) => $.desktop.server.connect.subtitle)}
      </p>

      {noneFound ? (
        <div
          role="status"
          className="mt-5.5 flex items-center gap-3 rounded-xl bg-surface-sunken px-3.5 py-3"
        >
          <WifiOff className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1 text-label leading-relaxed text-muted-foreground">
            {t(($) => $.desktop.server.connect.none)}
          </span>
          <Button variant="secondary" size="sm" className="shrink-0" onClick={onRescan}>
            {t(($) => $.desktop.server.connect.rescan)}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-5.5 flex h-7 items-center">
            <span id={headingId} className="text-label text-muted-foreground">
              {t(($) => $.desktop.server.connect.lan_heading)}
            </span>
            {scanning ? (
              <span
                role="status"
                className="ml-auto inline-flex items-center gap-1.5 text-label text-muted-foreground"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t(($) => $.desktop.server.connect.scanning)}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground"
                aria-label={t(($) => $.desktop.server.connect.rescan)}
                title={t(($) => $.desktop.server.connect.rescan)}
                onClick={onRescan}
              >
                <RefreshCw className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>

          <div
            role="radiogroup"
            aria-labelledby={headingId}
            className="mt-1.5 flex flex-col gap-1"
          >
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
        </>
      )}

      <div className="mt-4.5">
        <ServerAddressField
          value={address}
          onChange={onAddressChange}
          result={probe}
          onResult={onProbeResult}
          selected={manualSelected}
          onSelect={onPickAddress}
        />
      </div>

      <Button
        size="lg"
        className={cn(PRIMARY_BUTTON_CLASS, "mt-5 w-full")}
        disabled={continueDisabled}
        onClick={onContinue}
      >
        {t(($) => $.desktop.server.connect.continue)}
      </Button>
    </>
  );
}

interface ServerRowProps {
  server: DiscoveredServer;
  checked: boolean;
  onPick: () => void;
}

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
        "flex min-h-14.5 items-center gap-3 rounded-xl border px-3 py-2 text-left outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-foreground bg-field" : "border-surface-border hover:bg-field",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Server className="size-4.5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-body font-medium">
          <span className="truncate">{server.name}</span>
          {server.isLocal && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-1.5 text-micro font-normal text-muted-foreground">
              {t(($) => $.desktop.server.connect.local_badge)}
            </span>
          )}
        </span>
        <span className="truncate text-caption text-muted-foreground">{detail}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "size-4.5 shrink-0 rounded-full border-input",
          checked ? "border-[5px] border-foreground" : "border-[1.5px]",
        )}
      />
    </button>
  );
}

// 还没有任何服务器出现时的占位行。
function ScanningPlaceholder() {
  return (
    <div
      aria-hidden
      className="flex h-14.5 animate-pulse items-center gap-3 rounded-xl border border-dashed border-input px-3"
    >
      <span className="size-9 rounded-lg bg-skeleton" />
      <span className="flex flex-col gap-1.5">
        <span className="h-2.5 w-30 rounded-full bg-skeleton" />
        <span className="h-2 w-45 rounded-full bg-skeleton" />
      </span>
    </div>
  );
}

interface ConfirmStepProps {
  target: ConnectTarget;
  onBack: () => void;
}

function ConfirmStep({ target, onBack }: ConfirmStepProps) {
  const { t } = useT("settings");
  const [connecting, setConnecting] = useState(false);

  const { selected } = target;
  const insecure = new URL(selected.url).protocol === HTTP_PROTOCOL;
  const details = [
    { label: t(($) => $.desktop.server.confirm.address), value: selected.url, mono: true },
    { label: t(($) => $.desktop.server.confirm.version), value: target.version, mono: false },
    { label: t(($) => $.desktop.server.confirm.host), value: target.host, mono: true },
  ].filter((detail) => detail.value !== "");

  const handleConnect = async () => {
    setConnecting(true);

    try {
      // 保存后主进程会重载所有窗口，页面随即回到登录页。
      await window.desktopAPI.server.select(selected);
    } catch (err) {
      setConnecting(false);
      throw err;
    }
  };

  return (
    <>
      <h1 className={TITLE_CLASS}>
        {t(($) => $.desktop.server.confirm.title, { name: selected.name })}
      </h1>
      <p className={SUBTITLE_CLASS}>{t(($) => $.desktop.server.confirm.subtitle)}</p>

      <dl className="mt-6 flex flex-col rounded-xl bg-surface-sunken px-4 py-1">
        {details.map((detail, index) => (
          <div
            key={detail.label}
            className={cn(
              "flex min-h-10 items-center gap-3",
              index > 0 && "border-t border-surface-border",
            )}
          >
            <dt className="w-18 shrink-0 text-label text-muted-foreground">{detail.label}</dt>
            <dd
              className={cn("min-w-0 flex-1 truncate text-label", detail.mono && "font-mono")}
            >
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>

      {insecure && (
        <div
          role="note"
          className="mt-3 flex gap-2.5 rounded-xl bg-warning/10 px-3.5 py-3 text-label leading-relaxed"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>{t(($) => $.desktop.server.confirm.http_warning)}</span>
        </div>
      )}

      <div className="mt-6 flex gap-2.5">
        <Button
          variant="secondary"
          size="lg"
          className={cn(PRIMARY_BUTTON_CLASS, "flex-1 font-normal")}
          disabled={connecting}
          onClick={onBack}
        >
          {t(($) => $.desktop.server.confirm.back)}
        </Button>
        <Button
          size="lg"
          className={cn(PRIMARY_BUTTON_CLASS, "flex-1")}
          disabled={connecting}
          onClick={() => void handleConnect()}
        >
          {connecting && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {connecting
            ? t(($) => $.desktop.server.confirm.connecting)
            : t(($) => $.desktop.server.confirm.connect)}
        </Button>
      </div>
    </>
  );
}
