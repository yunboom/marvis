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
  const handleGoogleLogin = () => {
    // Open web login page in the default browser with platform=desktop flag.
    // The web callback will redirect back via marvis:// deep link with the token.
    window.desktopAPI.openExternal(
      `${webUrl}/login?platform=desktop`,
    );
  };

  // 飞书登录同样在浏览器里完成，再经深链回到桌面端；未配置时不显示按钮。
  const handleLarkLogin = larkLoginAppId ? handleGoogleLogin : undefined;

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        logo={<MarvisIcon className="size-12 text-foreground" />}
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
        onGoogleLogin={handleGoogleLogin}
        onLarkLogin={handleLarkLogin}
      />
    </div>
  );
}
