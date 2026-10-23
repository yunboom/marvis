import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@marvis/views/i18n";
import {
  SERVER_STATE_MOVED,
  SERVER_STATE_RECONNECTING,
  SERVER_STATE_REPLACED,
  SERVER_STATE_UNREACHABLE,
  type SelectedServer,
  type ServerStatus,
} from "../../../../shared/server-discovery";

// 跟随到新地址后主进程会重载窗口，页面里的提示会随之消失，
// 所以先记在 sessionStorage 里，窗口重载后再弹。
export const MOVED_NOTICE_STORAGE_KEY = "marvis:server-moved-notice";
// 超过这个时间还没被取走的通知视为过期（例如当时停在登录页），不再弹出。
const MOVED_NOTICE_MAX_AGE_MS = 60_000;

export type BannerState = typeof SERVER_STATE_RECONNECTING | typeof SERVER_STATE_UNREACHABLE;

// 横幅和弹窗文案里的服务器名称与地址（主机和端口，不带协议）。
export interface ServerLabel {
  name: string;
  address: string;
}

// “换了一台服务器”弹窗。关闭后 otherName 仍保留，避免关闭动画期间内容消失。
export interface ReplacedDialogState {
  open: boolean;
  otherName: string;
}

export interface ServerStatusView {
  // 横幅状态；null 表示不显示。
  banner: BannerState | null;
  server: ServerLabel;
  replaced: ReplacedDialogState;
  // “继续等待”：只关闭弹窗，横幅保留。
  dismissReplaced: () => void;
  retry: () => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function labelOf(saved: SelectedServer): ServerLabel {
  return { name: saved.name, address: hostOf(saved.url) };
}

// 还没读到已保存的选择（或手写预设没有保存过）时，用运行配置里的地址，主机名作为名称。
function labelFromRuntimeConfig(): ServerLabel {
  const result = window.desktopAPI.runtimeConfig;
  if (!result?.ok) return { name: "", address: "" };

  const host = hostOf(result.config.apiUrl);

  return { name: host, address: host };
}

function bannerOf(status: ServerStatus): BannerState | null {
  switch (status.state) {
    case SERVER_STATE_RECONNECTING:
      return SERVER_STATE_RECONNECTING;
    // 换了一台服务器对用户来说也是连不上原来那台：弹窗后面的横幅按不可达显示。
    case SERVER_STATE_UNREACHABLE:
    case SERVER_STATE_REPLACED:
      return SERVER_STATE_UNREACHABLE;
    default:
      return null;
  }
}

async function loadSavedServer(): Promise<SelectedServer | null> {
  try {
    return (await window.desktopAPI.server?.current()) ?? null;
  } catch {
    // 只用于显示名称，读不到就沿用运行配置里的主机名。
    return null;
  }
}

function rememberMovedNotice(url: string): void {
  try {
    sessionStorage.setItem(MOVED_NOTICE_STORAGE_KEY, JSON.stringify({ url, at: Date.now() }));
  } catch {
    // 存储不可用时只是重载后没有提示。
  }
}

// 取走并清除记下的通知；没有、损坏或已过期时返回 null。
function takeMovedNotice(): string | null {
  try {
    const raw = sessionStorage.getItem(MOVED_NOTICE_STORAGE_KEY);
    if (raw === null) return null;

    sessionStorage.removeItem(MOVED_NOTICE_STORAGE_KEY);

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const { url, at } = parsed as { url?: unknown; at?: unknown };
    if (typeof url !== "string" || typeof at !== "number") return null;
    if (Date.now() - at > MOVED_NOTICE_MAX_AGE_MS) return null;

    return url;
  } catch {
    return null;
  }
}

// 订阅已选服务器的连接状态，给横幅、弹窗和“已重新连接”提示提供数据。
// 主进程只在状态变化时推送；订阅时 preload 会先补发一次当前状态。
export function useServerStatus(): ServerStatusView {
  const { t } = useT("settings");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [replaced, setReplaced] = useState<ReplacedDialogState>({ open: false, otherName: "" });
  const [server, setServer] = useState<ServerLabel>(labelFromRuntimeConfig);

  useEffect(() => {
    // 可选调用：渲染进程热更新时可能还连着旧的 preload。
    return window.desktopAPI.server?.onStatus?.((next) => {
      if (next.state === SERVER_STATE_MOVED) rememberMovedNotice(next.url);

      setStatus(next);
      setReplaced((prev) =>
        next.state === SERVER_STATE_REPLACED
          ? { open: true, otherName: next.otherName }
          : { ...prev, open: false },
      );
    });
  }, []);

  // 掉线时用已保存的名称和地址，比运行配置里的主机名准确。
  const shown = status !== null && bannerOf(status) !== null;
  useEffect(() => {
    let cancelled = false;

    void loadSavedServer().then((saved) => {
      if (!cancelled && saved) setServer(labelOf(saved));
    });

    return () => {
      cancelled = true;
    };
  }, [shown]);

  // 跟随到新地址并重载窗口后，弹出“已重新连接”。
  useEffect(() => {
    const url = takeMovedNotice();
    if (url === null) return;

    // 窗口卸载后提示仍应弹出（全局 Toaster 不随它卸载），所以不取消。
    void loadSavedServer().then((saved) => {
      const name = saved?.name ?? hostOf(url);
      toast.success(t(($) => $.desktop.server.moved.title, { name }), {
        description: t(($) => $.desktop.server.moved.body, { address: hostOf(url) }),
      });
    });
    // 只在挂载时取一次；t 的变化不应触发重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissReplaced = useCallback(() => {
    setReplaced((prev) => ({ ...prev, open: false }));
  }, []);

  const retry = useCallback(() => {
    window.desktopAPI.server?.retry?.();
  }, []);

  return {
    banner: status === null ? null : bannerOf(status),
    server,
    replaced,
    dismissReplaced,
    retry,
  };
}
