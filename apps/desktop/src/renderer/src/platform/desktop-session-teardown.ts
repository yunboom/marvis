import { useTabStore } from "../stores/tab-store";
import { useWindowOverlayStore } from "../stores/window-overlay-store";
import {
  tearDownOnLogout,
  tearDownOnSessionExpiry,
  type SessionTeardown,
} from "./session-teardown";

// Binds the teardown steps to this renderer's real stores and IPC. Which of
// them each path runs — and why logout stops the daemon while an expiry
// leaves it running — lives in platform/session-teardown.
const sessionTeardown: SessionTeardown = {
  reportAuthSession: (userId) =>
    window.desktopAPI.reportAuthSession?.(userId),
  resetTabs: () => useTabStore.getState().reset(),
  closeOverlay: () => useWindowOverlayStore.getState().close(),
  clearDaemonToken: () => window.daemonAPI.clearToken(),
  stopDaemon: () => window.daemonAPI.stop(),
};

// 显式退出登录：CoreProvider 的 onLogout 和设置里的“切换服务器”共用。
// 返回的 Promise 在守护进程清理完成后落定，调用方可以等它再做后续动作。
export function handleDaemonLogout() {
  return tearDownOnLogout(sessionTeardown);
}

export function handleSessionExpired() {
  tearDownOnSessionExpiry(sessionTeardown);
}
