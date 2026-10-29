import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Cloud, Laptop, Link2, Loader2, RefreshCw, Server, Wifi, WifiOff } from "lucide-react";
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
import { DragStrip } from "@marvis/views/platform";
import {
  MARVIS_CLOUD_SERVER_URL,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
} from "../../../../shared/server-discovery";
import {
  STANDALONE_PHASE_DOWNLOADING,
  STANDALONE_PHASE_FAILED,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_PAUSED,
  STANDALONE_PHASE_STARTING,
  STANDALONE_PHASE_VERIFYING,
  type StandalonePhase,
  type StandaloneSetupInput,
  type StandaloneStatus,
} from "../../../../shared/standalone";
import { PREPARE_MODE_SETUP, StandalonePrepareScreen } from "../standalone/standalone-prepare-screen";
import { StandaloneSetupScreen } from "../standalone/standalone-setup-screen";
import { useStandaloneStatus } from "../standalone/use-standalone-status";
import {
  delay,
  PROBE_MIN_DISPLAY_MS,
  probeAddress,
  ProbeResultLine,
  ServerAddressField,
} from "./server-address-field";
import { useLanServers } from "./use-lan-servers";

const DETAIL_SEPARATOR = " · ";

const PRIMARY_BUTTON_CLASS = "h-12 w-full text-body-lg";

// 选择「在这台电脑上使用」（单机模式）。
const PICK_STANDALONE = "standalone";
// 选择「Marvis 云服务」。保存时按手动输入的地址记录来源，server.json 的取值不变。
const PICK_CLOUD = "cloud";

// 云服务选项副标题里的地址：去掉协议，保留路径前缀。
const CLOUD_SERVER_HOST = MARVIS_CLOUD_SERVER_URL.replace(/^https?:\/\//, "");

// 连接页的三步：选择、单机模式设置、准备资源。
const STEP_PICK = "pick";
const STEP_SETUP = "setup";
const STEP_PREPARE = "prepare";
type Step = typeof STEP_PICK | typeof STEP_SETUP | typeof STEP_PREPARE;

// 上次退出时还在准备中的阶段：回来后直接打开「准备资源」页。
const PREPARING_PHASES: StandalonePhase[] = [
  STANDALONE_PHASE_DOWNLOADING,
  STANDALONE_PHASE_PAUSED,
  STANDALONE_PHASE_VERIFYING,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_STARTING,
];

function resumesPreparation(status: StandaloneStatus): boolean {
  if (PREPARING_PHASES.includes(status.phase)) return true;

  return status.phase === STANDALONE_PHASE_FAILED && status.version === null;
}

// 用户在选择步骤里明确点选过的项；null 表示还没有操作，使用默认选中项。
type UserPick =
  | { kind: typeof PICK_CLOUD }
  | { kind: typeof PICK_STANDALONE }
  | { kind: typeof SERVER_SOURCE_LAN; url: string }
  | { kind: typeof SERVER_SOURCE_MANUAL };

// 当前生效的选中项：云服务、这台电脑、局域网中的某个服务器，或手动输入的地址。
type Selection =
  | { kind: typeof PICK_CLOUD }
  | { kind: typeof PICK_STANDALONE }
  | { kind: typeof SERVER_SOURCE_LAN; server: DiscoveredServer }
  | { kind: typeof SERVER_SOURCE_MANUAL };

// 点“连接”时落盘的服务器，以及左栏摘要要展示的版本。
interface ConnectTarget {
  selected: SelectedServer;
  version: string;
}

// 没有点选过时的默认项：首次启动是云服务，从已有会话切换服务器时沿用原来的默认项（这台电脑）。
type DefaultPick = typeof PICK_CLOUD | typeof PICK_STANDALONE;

function resolveSelection(
  pick: UserPick | null,
  servers: DiscoveredServer[],
  defaultPick: DefaultPick,
): Selection {
  if (pick?.kind === SERVER_SOURCE_MANUAL) return { kind: SERVER_SOURCE_MANUAL };
  if (pick?.kind === PICK_CLOUD) return { kind: PICK_CLOUD };
  if (pick === null && defaultPick === PICK_CLOUD) return { kind: PICK_CLOUD };

  if (pick?.kind === SERVER_SOURCE_LAN) {
    const picked = servers.find((server) => server.compatible && server.url === pick.url);
    if (picked) return { kind: SERVER_SOURCE_LAN, server: picked };
  }

  // 点选过的服务器从列表里消失时回到这台电脑。
  return { kind: PICK_STANDALONE };
}

function probedTarget(probe: ProbeResult | null): ConnectTarget | null {
  if (probe?.kind !== "ok") return null;

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

function toConnectTarget(
  selection: Selection,
  probe: ProbeResult | null,
  cloudProbe: ProbeResult | null,
): ConnectTarget | null {
  if (selection.kind === PICK_CLOUD) return probedTarget(cloudProbe);

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

  if (selection.kind === SERVER_SOURCE_MANUAL) return probedTarget(probe);

  return null;
}

// 选中项在左栏摘要里的一行：名称 + 地址 · 版本。
function serverSummaryLine(url: string, version: string): string {
  return [new URL(url).host, version].filter((part) => part !== "").join(DETAIL_SEPARATOR);
}

// 桌面端首次启动（还没有选择服务器）时的连接页：可以连接 Marvis 云服务、在这台电脑上使用（单机模式），
// 也可以连接局域网中或手动输入的服务器，选好后点按钮直接保存并重载。
// 还没有保存过服务器时默认选中云服务并立即测试连接，通过后由用户点“连接”。
// 两栏布局与引导页一致：左栏标题、已选项摘要和按钮，右栏是选项列表和地址栏。
export function ConnectServerScreen({
  firstRun = false,
  suggestedAddress,
  beforeSwitch,
  onBack,
}: {
  /** 还没有保存过服务器（首次启动）：默认选中云服务并立即测试；切换服务器时沿用原来的默认项。 */
  firstRun?: boolean;
  /** 预填进地址栏的地址（开发模式下的本地后端）；缺省时地址栏为空。 */
  suggestedAddress?: string;
  /** 保存选择前执行，例如已登录时先退出旧服务器的账号。 */
  beforeSwitch?: () => Promise<void>;
  /** 提供时在按钮下方显示「返回」，回到打开这个页面的地方。 */
  onBack?: () => void;
}) {
  const [step, setStep] = useState<Step>(STEP_PICK);
  const [setupValue, setSetupValue] = useState<StandaloneSetupInput | null>(null);
  const status = useStandaloneStatus();
  // 只看第一次推送：上次退出时还在准备资源，回来后直接打开「准备资源」页。
  const resumeCheckedRef = useRef(false);

  useEffect(() => {
    if (status === null || resumeCheckedRef.current) return;

    resumeCheckedRef.current = true;
    if (resumesPreparation(status)) setStep(STEP_PREPARE);
  }, [status]);

  const backToPick = useCallback(() => setStep(STEP_PICK), []);
  const openSetup = useCallback(() => setStep(STEP_SETUP), []);
  const openPrepare = useCallback(() => setStep(STEP_PREPARE), []);

  if (step === STEP_SETUP) {
    return (
      <StandaloneSetupScreen
        value={setupValue}
        onChange={setSetupValue}
        onBack={backToPick}
        onStarted={openPrepare}
      />
    );
  }

  if (step === STEP_PREPARE) {
    return (
      <StandalonePrepareScreen
        status={status}
        mode={PREPARE_MODE_SETUP}
        onEditSettings={openSetup}
        onCancelled={backToPick}
      />
    );
  }

  return (
    <PickStep
      firstRun={firstRun}
      suggestedAddress={suggestedAddress}
      status={status}
      onSetupStandalone={openSetup}
      onEnterFailed={openPrepare}
      beforeSwitch={beforeSwitch}
      onBack={onBack}
    />
  );
}

interface CloudProbe {
  result: ProbeResult | null;
  testing: boolean;
  run: () => void;
}

// 测试 Marvis 云服务的连接。结果保存在连接页，切到别的选项再回来时仍然保留。
function useCloudProbe(): CloudProbe {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  // 每次测试递增，用来丢弃过期或卸载后的结果。
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const run = useCallback(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;

    setTesting(true);

    void Promise.all([probeAddress(MARVIS_CLOUD_SERVER_URL), delay(PROBE_MIN_DISPLAY_MS)]).then(
      ([probed]) => {
        if (requestRef.current !== requestId) return;

        setTesting(false);
        setResult(probed);
      },
    );
  }, []);

  return { result, testing, run };
}

interface PickStepProps {
  firstRun: boolean;
  suggestedAddress?: string;
  status: StandaloneStatus | null;
  onSetupStandalone: () => void;
  /** 进入单机模式失败：转到状态页显示原因。 */
  onEnterFailed: () => void;
  beforeSwitch?: () => Promise<void>;
  onBack?: () => void;
}

function PickStep({
  firstRun,
  suggestedAddress,
  status,
  onSetupStandalone,
  onEnterFailed,
  beforeSwitch,
  onBack,
}: PickStepProps) {
  const { t } = useT("settings");
  const [pick, setPick] = useState<UserPick | null>(null);
  const [address, setAddress] = useState(suggestedAddress ?? "");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  const { servers: discovered, scanning, rescan } = useLanServers();
  const cloud = useCloudProbe();
  const { run: runCloudProbe } = cloud;
  const defaultPick: DefaultPick = firstRun ? PICK_CLOUD : PICK_STANDALONE;

  // 首次启动：打开页面就测试云服务，只测一次。
  const autoProbedRef = useRef(false);
  useEffect(() => {
    if (!firstRun || autoProbedRef.current) return;

    autoProbedRef.current = true;
    runCloudProbe();
  }, [firstRun, runCloudProbe]);

  // 本机单机模式开了局域网连接后也会被扫到，只在「这台电脑」里显示。
  const servers = discovered.filter((server) => status?.lanUrl == null || server.url !== status.lanUrl);
  const selection = resolveSelection(pick, servers, defaultPick);
  const noneFound = !scanning && servers.length === 0;
  const standaloneVersion = status?.version ?? null;
  const standaloneInstalled = standaloneVersion !== null;

  let primaryDisabled: boolean;
  if (selection.kind === PICK_STANDALONE) {
    // 状态还没推过来时不知道是「下一步」还是「继续」。
    primaryDisabled = status === null;
  } else if (selection.kind === SERVER_SOURCE_MANUAL) {
    primaryDisabled = probe?.kind !== "ok";
  } else if (selection.kind === PICK_CLOUD) {
    primaryDisabled = cloud.result?.kind !== "ok";
  } else {
    primaryDisabled = false;
  }

  const summaryTarget = toConnectTarget(selection, probe, cloud.result);
  // 云服务还没测试通过时摘要第二行：测试中、失败原因，或还没测试。
  let cloudPendingLine: string;
  if (cloud.testing) {
    cloudPendingLine = t(($) => $.desktop.server.address.testing);
  } else {
    switch (cloud.result?.kind) {
      case "unreachable":
        cloudPendingLine = t(($) => $.desktop.server.probe.unreachable);
        break;
      case "not_marvis":
        cloudPendingLine = t(($) => $.desktop.server.probe.not_marvis);
        break;
      case "too_old":
        cloudPendingLine = t(($) => $.desktop.server.probe.too_old);
        break;
      default:
        cloudPendingLine = t(($) => $.desktop.server.connect.summary_manual_hint);
    }
  }
  let summary: { name: string; line: string; picked: boolean };
  if (selection.kind === PICK_STANDALONE) {
    summary = {
      name: t(($) => $.desktop.standalone.pick.option),
      line: standaloneInstalled
        ? t(($) => $.desktop.standalone.pick.ready, { version: standaloneVersion })
        : t(($) => $.desktop.standalone.pick.summary_setup),
      picked: true,
    };
  } else if (selection.kind === PICK_CLOUD) {
    summary = {
      name: t(($) => $.desktop.server.connect.cloud_option),
      line: summaryTarget
        ? serverSummaryLine(summaryTarget.selected.url, summaryTarget.version)
        : cloudPendingLine,
      picked: summaryTarget !== null,
    };
  } else if (summaryTarget) {
    summary = {
      name: summaryTarget.selected.name,
      line: serverSummaryLine(summaryTarget.selected.url, summaryTarget.version),
      picked: true,
    };
  } else {
    summary = {
      name: t(($) => $.desktop.server.connect.summary_manual),
      line: t(($) => $.desktop.server.connect.summary_manual_hint),
      picked: false,
    };
  }

  const handleEnterStandalone = async () => {
    setConnecting(true);
    try {
      if (beforeSwitch) await beforeSwitch();
      // 主进程选定本机、重载窗口，并用 auth:token 送来管理员登录凭证。
      await window.desktopAPI.standalone.enter();
    } catch {
      setConnecting(false);
      toast.error(t(($) => $.desktop.standalone.prepare.enter_failed));
      onEnterFailed();
    }
  };

  const handleConnect = async () => {
    if (!summaryTarget) return;

    setConnecting(true);
    try {
      if (beforeSwitch) await beforeSwitch();
      // 保存后主进程会重载所有窗口，页面随即回到登录页。
      await window.desktopAPI.server.select(summaryTarget.selected);
    } catch (err) {
      setConnecting(false);
      throw err;
    }
  };

  const handlePrimary = () => {
    if (selection.kind !== PICK_STANDALONE) {
      void handleConnect();
      return;
    }
    if (standaloneInstalled) {
      void handleEnterStandalone();
      return;
    }
    onSetupStandalone();
  };

  let primaryLabel: string;
  if (selection.kind === PICK_STANDALONE) {
    if (connecting) primaryLabel = t(($) => $.desktop.standalone.pick.entering);
    else if (standaloneInstalled) primaryLabel = t(($) => $.desktop.standalone.pick.continue);
    else primaryLabel = t(($) => $.desktop.standalone.pick.next);
  } else {
    primaryLabel = connecting
      ? t(($) => $.desktop.server.confirm.connecting)
      : t(($) => $.desktop.server.confirm.connect);
  }

  return (
    <div className="flex h-screen flex-col bg-app-shell text-foreground">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center overflow-auto px-4 py-8">
        <SplitCard>
          <SplitCardIntro>
            <MarvisIcon className="size-9 text-foreground" />

            <h1 className="mt-8 text-display-sm font-bold [@media(max-height:760px)]:mt-5">{t(($) => $.desktop.server.connect.title)}</h1>
            <p className="mt-3 text-body leading-relaxed text-muted-foreground">
              {t(($) => $.desktop.server.connect.subtitle)}
            </p>

            <div className="mt-7 flex items-center gap-3 rounded-2xl bg-surface-sunken px-3.5 py-3 [@media(max-height:760px)]:mt-5">
              <span
                aria-hidden
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-tile text-background",
                  summary.picked ? "bg-foreground" : "bg-input",
                )}
              >
                {summaryIcon(selection.kind)}
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
            <div className="flex min-h-[320px] flex-1 flex-col overflow-y-auto rounded-pane bg-surface-sunken md:min-h-0">
              <PickPane
                servers={servers}
                scanning={scanning}
                noneFound={noneFound}
                selection={selection}
                standaloneVersion={standaloneVersion}
                cloud={cloud}
                onPickCloud={() => {
                  setPick({ kind: PICK_CLOUD });
                  // 保存过服务器时云服务没有自动测试，选中时补测一次。
                  if (cloud.result === null && !cloud.testing) runCloudProbe();
                }}
                address={address}
                probe={probe}
                onRescan={rescan}
                onPickStandalone={() => setPick({ kind: PICK_STANDALONE })}
                onPickServer={(server) => setPick({ kind: SERVER_SOURCE_LAN, url: server.url })}
                onPickAddress={() => setPick({ kind: SERVER_SOURCE_MANUAL })}
                onAddressChange={setAddress}
                onProbeResult={setProbe}
              />
            </div>
          </SplitCardPane>

          <SplitCardActions className="gap-2">
            <Button
              size="lg"
              className={PRIMARY_BUTTON_CLASS}
              disabled={primaryDisabled || connecting}
              aria-busy={connecting || undefined}
              onClick={handlePrimary}
            >
              {connecting && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {primaryLabel}
            </Button>
            {onBack && (
              <Button
                variant="ghost"
                size="lg"
                className={PRIMARY_BUTTON_CLASS}
                disabled={connecting}
                onClick={onBack}
              >
                {t(($) => $.desktop.server.connect.back)}
              </Button>
            )}
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
  standaloneVersion: string | null;
  cloud: CloudProbe;
  onPickCloud: () => void;
  address: string;
  probe: ProbeResult | null;
  onRescan: () => void;
  onPickStandalone: () => void;
  onPickServer: (server: DiscoveredServer) => void;
  onPickAddress: () => void;
  onAddressChange: (value: string) => void;
  onProbeResult: (result: ProbeResult | null) => void;
}

// 每一组选项的小标题：图标 + 名称，右侧可放操作。
function SectionHeading({
  id,
  icon,
  label,
  action,
}: {
  id?: string;
  icon: ReactNode;
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-9 items-center gap-2 px-2.5 text-caption text-muted-foreground">
      {icon}
      <span id={id} className="font-semibold text-foreground">
        {label}
      </span>
      {action}
    </div>
  );
}

function SectionDivider() {
  return <span aria-hidden className="mx-2.5 my-2 h-px bg-surface-border" />;
}

// 选项按组排列：云服务、这台电脑、局域网、其他地址，每组一个小标题，组间用分隔线隔开。
function PickPane({
  servers,
  scanning,
  noneFound,
  selection,
  standaloneVersion,
  cloud,
  onPickCloud,
  address,
  probe,
  onRescan,
  onPickStandalone,
  onPickServer,
  onPickAddress,
  onAddressChange,
  onProbeResult,
}: PickPaneProps) {
  const { t } = useT("settings");
  const cloudHeadingId = useId();
  const localHeadingId = useId();
  const headingId = useId();

  let lanAction: ReactNode = null;
  if (scanning) {
    lanAction = (
      <span role="status" className="ml-auto inline-flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {t(($) => $.desktop.server.connect.scanning)}
      </span>
    );
  } else if (!noneFound) {
    // 没有找到时空状态里已有“重新查找”，小标题不再重复。
    lanAction = (
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6.5 gap-1 px-2 text-caption font-normal text-muted-foreground"
        onClick={onRescan}
      >
        <RefreshCw className="size-3" aria-hidden />
        {t(($) => $.desktop.server.connect.rescan)}
      </Button>
    );
  }

  return (
    <div className="flex flex-col p-2">
      <SectionHeading
        id={cloudHeadingId}
        icon={<Cloud className="size-3.5" aria-hidden />}
        label={t(($) => $.desktop.server.connect.cloud_heading)}
      />
      <div role="radiogroup" aria-labelledby={cloudHeadingId} className="flex flex-col">
        <CloudRow checked={selection.kind === PICK_CLOUD} cloud={cloud} onPick={onPickCloud} />
      </div>
      <SectionDivider />

      <SectionHeading
        id={localHeadingId}
        icon={<Laptop className="size-3.5" aria-hidden />}
        label={t(($) => $.desktop.standalone.pick.heading)}
      />
      <div role="radiogroup" aria-labelledby={localHeadingId} className="flex flex-col">
        <StandaloneRow
          checked={selection.kind === PICK_STANDALONE}
          version={standaloneVersion}
          onPick={onPickStandalone}
        />
      </div>
      <SectionDivider />

      <SectionHeading
        id={headingId}
        icon={<Wifi className="size-3.5" aria-hidden />}
        label={t(($) => $.desktop.server.connect.lan_heading)}
        action={lanAction}
      />
      {noneFound ? (
        <div role="status" className="flex items-start gap-3 px-3 pt-1 pb-2">
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
      )}
      <SectionDivider />

      <SectionHeading
        icon={<Link2 className="size-3.5" aria-hidden />}
        label={t(($) => $.desktop.server.settings.other_address)}
      />
      <ServerAddressField
        variant="pane"
        value={address}
        onChange={onAddressChange}
        placeholder={MARVIS_CLOUD_SERVER_URL}
        result={probe}
        onResult={onProbeResult}
        selected={selection.kind === SERVER_SOURCE_MANUAL}
        onSelect={onPickAddress}
      />
    </div>
  );
}

// 「Marvis 云服务」：副标题是地址，测试中显示进度，可以连接时带绿点；
// 测试失败时在行下方给出原因和“重试”（按钮不能放进 radio 里，辅助技术会剪掉它）。
function CloudRow({
  checked,
  cloud,
  onPick,
}: {
  checked: boolean;
  cloud: CloudProbe;
  onPick: () => void;
}) {
  const { t } = useT("settings");
  const ok = cloud.result?.kind === "ok";
  const failed = !cloud.testing && cloud.result !== null && !ok;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onPick}
        className={cn(
          "flex min-h-17 items-center gap-3 rounded-option py-2 pr-3.5 pl-2.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          checked
            ? "bg-surface shadow-[0_0_0_1.5px_var(--color-foreground)]"
            : "hover:bg-surface/60",
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-foreground ring-1 ring-surface-border">
          <Cloud className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium">
            {t(($) => $.desktop.server.connect.cloud_option)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-faint-foreground">
            {cloud.testing ? (
              <>
                <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
                <span className="truncate">{t(($) => $.desktop.server.address.testing)}</span>
              </>
            ) : (
              <>
                {ok && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
                <span className="truncate">{CLOUD_SERVER_HOST}</span>
              </>
            )}
          </span>
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
      {failed && cloud.result !== null && (
        <div className="flex items-center gap-2 pr-1 pl-1.5">
          <div className="min-w-0 flex-1">
            <ProbeResultLine result={cloud.result} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6.5 shrink-0 gap-1 px-2 text-caption font-normal text-muted-foreground"
            onClick={cloud.run}
          >
            <RefreshCw className="size-3" aria-hidden />
            {t(($) => $.desktop.server.banner.retry)}
          </Button>
        </div>
      )}
    </div>
  );
}

// 左栏摘要里的图标。
function summaryIcon(kind: Selection["kind"]): ReactNode {
  if (kind === PICK_STANDALONE) return <Laptop className="size-4.5" />;
  if (kind === PICK_CLOUD) return <Cloud className="size-4.5" />;

  return <Server className="size-4.5" />;
}

interface ServerRowProps {
  server: DiscoveredServer;
  checked: boolean;
  onPick: () => void;
}

// 「在这台电脑上使用」：未安装时提示首次下载的大小，已安装时显示版本。
function StandaloneRow({
  checked,
  version,
  onPick,
}: {
  checked: boolean;
  version: string | null;
  onPick: () => void;
}) {
  const { t } = useT("settings");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={cn(
        "flex min-h-17 items-center gap-3 rounded-option py-2 pr-3.5 pl-2.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        checked
          ? "bg-surface shadow-[0_0_0_1.5px_var(--color-foreground)]"
          : "hover:bg-surface/60",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-foreground ring-1 ring-surface-border">
        <Laptop className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-body font-medium">
          <span className="truncate">{t(($) => $.desktop.standalone.pick.option)}</span>
          <span className="shrink-0 text-caption font-normal text-faint-foreground">
            {t(($) => $.desktop.standalone.pick.badge)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-faint-foreground">
          {version !== null && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
          <span className="truncate">
            {version !== null
              ? t(($) => $.desktop.standalone.pick.ready, { version })
              : t(($) => $.desktop.standalone.pick.not_installed)}
          </span>
        </span>
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
        "flex min-h-14 items-center gap-3 rounded-option py-2 pr-3.5 pl-2.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-surface shadow-[0_0_0_1.5px_var(--color-foreground)]"
          : "hover:bg-surface/60",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-muted-foreground ring-1 ring-surface-border">
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
      <span className="size-8 rounded-md bg-skeleton" />
      <span className="flex flex-col gap-1.5">
        <span className="h-2.5 w-30 rounded-full bg-skeleton" />
        <span className="h-2 w-45 rounded-full bg-skeleton" />
      </span>
    </div>
  );
}
