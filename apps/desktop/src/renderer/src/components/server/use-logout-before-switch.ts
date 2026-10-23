import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@marvis/core/auth";
import { clearClientSessionData } from "@marvis/core/platform";
import { handleDaemonLogout } from "../../platform/desktop-session-teardown";

// 切换服务器前的退出登录：守护进程清理 + 网页会话清理。
export function useLogoutBeforeSwitch() {
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
