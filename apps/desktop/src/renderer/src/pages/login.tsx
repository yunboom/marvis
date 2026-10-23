import { useConfigStore } from "@marvis/core/config";
import { LoginPage } from "@marvis/views/auth";
import { DragStrip } from "@marvis/views/platform";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";

function requireRuntimeAppUrl(): string {
  const runtimeConfig = window.desktopAPI.runtimeConfig;
  if (!runtimeConfig.ok) {
    throw new Error(
      "Invariant violated: DesktopLoginPage rendered before App accepted runtime config",
    );
  }
  return runtimeConfig.config.appUrl;
}

export function DesktopLoginPage() {
  const webUrl = requireRuntimeAppUrl();
  const larkLoginAppId = useConfigStore((state) => state.larkLoginAppId);
  const larkDesktopLogin = useConfigStore((state) => state.larkDesktopLogin);
  // 没有网页端时浏览器里没有登录页可去，Google 登录隐藏。
  const hasWebApp = webUrl !== "";
  const handleGoogleLogin = () => {
    // Open web login page in the default browser with platform=desktop flag.
    // The web callback will redirect back via marvis:// deep link with the token.
    window.desktopAPI.openExternal(
      `${webUrl}/login?platform=desktop`,
    );
  };

  // 飞书登录在浏览器里完成，再经深链回到桌面端：有网页端时走网页登录页；
  // 没有网页端时由服务端直接完成飞书回调，主进程负责打开浏览器并校验回来的深链。
  // 都不可用时不显示按钮。
  const handleLarkDesktopLogin = () => {
    void window.desktopAPI.startLarkDesktopLogin();
  };
  let handleLarkLogin: (() => void) | undefined;
  if (hasWebApp) {
    handleLarkLogin = larkLoginAppId ? handleGoogleLogin : undefined;
  } else if (larkDesktopLogin) {
    handleLarkLogin = handleLarkDesktopLogin;
  }

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        logo={<MarvisIcon className="size-12 text-foreground" />}
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
        onGoogleLogin={hasWebApp ? handleGoogleLogin : undefined}
        onLarkLogin={handleLarkLogin}
      />
    </div>
  );
}
