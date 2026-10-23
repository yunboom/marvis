import { ElectronAPI } from "@electron-toolkit/preload";
import type { RuntimeConfigResult } from "../shared/runtime-config";
import type { NavigationGesture } from "../shared/navigation-gestures";
import type { RendererRouteContextInput } from "../shared/renderer-route-context";
import type { FreezeBreadcrumb } from "../shared/freeze-breadcrumb";
import type {
  DesktopWindowContext,
  IssueWindowRequest,
} from "../shared/issue-window";
import type {
  ManualUpdateCheckResult,
  UpdaterPreferences,
} from "../shared/updater-types";
import type {
  DaemonStatus,
  DaemonPrefs,
  LocalRuntimeProbe,
} from "../shared/daemon-types";
import type { TabSelectionShortcutKey } from "../shared/main-renderer-messages";
import type {
  DiscoveredServer,
  ProbeResult,
  SelectedServer,
  ServerStatus,
} from "../shared/server-discovery";

interface ServerAPI {
  /** 订阅局域网里发现的 Marvis 服务器，列表变化时回调。返回取消订阅函数。 */
  discover: (onChange: (list: DiscoveredServer[]) => void) => () => void;
  /** 重新扫描局域网，并重新核实已发现的服务器。 */
  rescan: () => void;
  /** 请求 `<url>/api/config` 核实对方是不是 Marvis 服务器。 */
  probe: (url: string) => Promise<ProbeResult>;
  /** 已保存的服务器选择；没有选择过时为 null。 */
  current: () => Promise<SelectedServer | null>;
  /** 保存所选服务器并重载所有窗口。 */
  select: (server: SelectedServer) => Promise<void>;
  /** 订阅已选服务器的连接状态：先回调一次当前状态，之后每次变化回调。返回取消订阅函数。 */
  onStatus: (callback: (status: ServerStatus) => void) => () => void;
  /** 请求主进程立即重试连接已选服务器。 */
  retry: () => void;
}

interface DesktopAPI {
  /** App version + normalized OS, captured synchronously at preload time. */
  appInfo: {
    version: string;
    os: "macos" | "windows" | "linux" | "unknown";
  };
  /** OS-preferred locale (BCP 47) injected by main via additionalArguments. */
  systemLocale: string;
  /** Subscribe to OS language changes detected after boot. Returns an unsubscribe function. */
  onSystemLocaleChanged: (callback: (locale: string) => void) => () => void;
  /** Validated runtime endpoint config, or a blocking config error. */
  runtimeConfig: RuntimeConfigResult;
  /** Main tabbed window or a dedicated issue-only window. */
  windowContext: DesktopWindowContext;
  /** Read any freeze/crash breadcrumb from a previous session, so the renderer
   *  can flush it to telemetry on boot. Null when nothing's pending. Reading
   *  does not consume it — acknowledge with `ackFreeze`. */
  getLastFreeze: () => FreezeBreadcrumb | null;
  /** Retire the breadcrumb with this exact timestamp once its event has been
   *  handed to analytics. Unacknowledged breadcrumbs are retried next boot. */
  ackFreeze: (ts: number) => void;
  /** Report the resolved account identity so stale issue windows can close. */
  reportAuthSession: (userId: string | null) => void;
  /** Listen for auth token delivered via deep link. Returns an unsubscribe function. */
  onAuthToken: (callback: (token: string) => void) => () => void;
  /** Listen for invitation IDs delivered via deep link. Returns an unsubscribe function. */
  onInviteOpen: (callback: (invitationId: string) => void) => () => void;
  /** 监听深链 marvis://open 解出的站内路径。返回取消订阅函数。 */
  onOpenPath: (callback: (path: string) => void) => () => void;
  /** Open a URL in the default browser. */
  openExternal: (url: string) => Promise<void>;
  /** 没有网页端时的飞书登录：主进程生成一次性 nonce，用浏览器打开服务端的飞书登录地址。 */
  startLarkDesktopLogin: () => Promise<void>;
  /** Download a file by URL through Electron's native download system.
   *  Shows a native save dialog. On non-desktop platforms this is undefined. */
  downloadURL: (url: string) => Promise<void>;
  /** Hide macOS traffic lights for full-screen modals; restore when false. */
  setImmersiveMode: (immersive: boolean) => Promise<void>;
  /** Show a native OS notification for a new inbox item. */
  showNotification: (payload: {
    slug: string;
    itemId: string;
    issueKey: string;
    title: string;
    body: string;
  }) => void;
  /** Update the OS dock / taskbar unread badge. Pass 0 to clear. */
  setUnreadBadge: (count: number) => void;
  /** Listen for "open inbox row" requests from notification clicks. Returns an unsubscribe function. */
  onInboxOpen: (
    callback: (payload: {
      slug: string;
      itemId: string;
      issueKey: string;
    }) => void,
  ) => () => void;
  /** Listen for native macOS back/forward swipe gestures. Returns an unsubscribe function. */
  onNavigationGesture: (callback: (gesture: NavigationGesture) => void) => () => void;
  /** Report the renderer's memory-router path for recovery diagnostics. */
  setRendererRouteContext: (context: RendererRouteContextInput) => void;
  /** Open the OS folder picker and return the chosen absolute path.
   *  Used by the Project settings "Add local directory" flow. */
  pickDirectory: (
    defaultPath?: string,
  ) => Promise<{
    ok: boolean;
    path?: string;
    basename?: string;
    reason?: "cancelled" | "no_window" | "error";
    error?: string;
  }>;
  /** Validate that a path is an existing readable+writable directory.
   *  Mirrors the daemon's runtime check so the user sees errors before submit. */
  validateLocalDirectory: (
    path: string,
  ) => Promise<{
    ok: boolean;
    reason?:
      | "not_absolute"
      | "not_found"
      | "not_a_directory"
      | "not_readable"
      | "not_writable"
      | "error";
    error?: string;
    /** Whether the path sits inside a git working tree. Only set when ok=true.
     *  Drives the worktree execution-mode option in the resource UI. */
    is_git_repo?: boolean;
  }>;
  /** Listen for Cmd/Ctrl+W tab-close requests from the main process.
   *  Returns an unsubscribe function. */
  onCloseActiveTab: (callback: () => void) => () => void;
  /** Listen for Cmd/Ctrl+, requests to open Settings, delivered to the main
   *  window whichever window had focus. Returns an unsubscribe function. */
  onOpenSettings: (callback: () => void) => () => void;
  /** Listen for Cmd/Ctrl+1..9 tab-selection requests, delivered to the main
   *  window whichever window had focus. Returns an unsubscribe function. */
  onSelectTabShortcut: (
    callback: (key: TabSelectionShortcutKey) => void,
  ) => () => void;
  /** Ask the main process to close the window. */
  closeWindow: () => void;
  /** Open an issue-detail tab in a dedicated native window. */
  openIssueWindow: (
    request: IssueWindowRequest,
  ) => Promise<{ ok: true } | { ok: false; reason: "invalid_request" }>;
  /** 服务器发现、探测与选择。 */
  server: ServerAPI;
}

type DaemonReauthResult =
  | { ok: true }
  | { ok: false; reason: "session_invalid" }
  | { ok: false; reason: "transient"; message: string };

interface DaemonAPI {
  start: () => Promise<{ success: boolean; error?: string }>;
  stop: () => Promise<{ success: boolean; error?: string }>;
  restart: () => Promise<{ success: boolean; error?: string }>;
  getStatus: () => Promise<DaemonStatus>;
  probeRuntimes: () => Promise<LocalRuntimeProbe>;
  getHostName: () => Promise<string>;
  onStatusChange: (callback: (status: DaemonStatus) => void) => () => void;
  setTargetApiUrl: (url: string) => Promise<void>;
  syncToken: (token: string, userId: string) => Promise<void>;
  clearToken: () => Promise<void>;
  reauthenticate: (
    token: string,
    userId: string,
  ) => Promise<DaemonReauthResult>;
  isCliInstalled: () => Promise<boolean>;
  getPrefs: () => Promise<DaemonPrefs>;
  setPrefs: (prefs: Partial<DaemonPrefs>) => Promise<DaemonPrefs>;
  autoStart: () => Promise<void>;
  retryInstall: () => Promise<void>;
  startLogStream: () => void;
  stopLogStream: () => void;
  onLogLine: (callback: (line: string) => void) => () => void;
  openLogFile: () => Promise<{ success: boolean; error?: string }>;
}

interface UpdaterAPI {
  onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: string }) => void) => () => void;
  onDownloadProgress: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (
    callback: (info: { version: string; releaseNotes?: string }) => void,
  ) => () => void;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getPreferences: () => Promise<UpdaterPreferences>;
  setAutomaticUpdates: (enabled: boolean) => Promise<UpdaterPreferences>;
  checkForUpdates: () => Promise<ManualUpdateCheckResult>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    desktopAPI: DesktopAPI;
    daemonAPI: DaemonAPI;
    updater: UpdaterAPI;
  }
}

export {};
