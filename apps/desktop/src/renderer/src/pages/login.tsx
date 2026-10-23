import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useConfigStore } from "@marvis/core/config";
import { LoginPage } from "@marvis/views/auth";
import { useT } from "@marvis/views/i18n";
import { DragStrip } from "@marvis/views/platform";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { Button } from "@marvis/ui/components/ui/button";
import { SERVER_SOURCE_STANDALONE } from "../../../shared/server-discovery";

function requireRuntimeAppUrl(): string {
  const runtimeConfig = window.desktopAPI.runtimeConfig;
  if (!runtimeConfig.ok) {
    throw new Error(
      "Invariant violated: DesktopLoginPage rendered before App accepted runtime config",
    );
  }
  return runtimeConfig.config.appUrl;
}

// 已保存的选择是不是单机模式；读取中或读取失败按否处理。
function useIsStandaloneSelected(): boolean {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.desktopAPI.server
      .current()
      .then((selected) => {
        if (!cancelled) setStandalone(selected?.source === SERVER_SOURCE_STANDALONE);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return standalone;
}

// 单机模式下这台电脑的主人直接以管理员身份进入；同事仍用下面的邮箱或飞书登录。
function StandaloneAdminLogin() {
  const { t } = useT("settings");
  const [entering, setEntering] = useState(false);

  const handleEnter = async () => {
    setEntering(true);
    try {
      // 成功后主进程重载窗口并送来登录凭证，这里不用复位。
      await window.desktopAPI.standalone.enter();
    } catch {
      setEntering(false);
      toast.error(t(($) => $.desktop.standalone.login.admin_failed));
    }
  };

  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full"
      disabled={entering}
      aria-busy={entering || undefined}
      onClick={() => void handleEnter()}
    >
      {entering && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {entering
        ? t(($) => $.desktop.standalone.login.admin_busy)
        : t(($) => $.desktop.standalone.login.admin)}
    </Button>
  );
}

export function DesktopLoginPage() {
  const webUrl = requireRuntimeAppUrl();
  const larkLoginAppId = useConfigStore((state) => state.larkLoginAppId);
  const larkDesktopLogin = useConfigStore((state) => state.larkDesktopLogin);
  // 没有网页端时浏览器里没有登录页可去，Google 登录隐藏。
  const hasWebApp = webUrl !== "";
  const standalone = useIsStandaloneSelected();
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
        extra={standalone ? <StandaloneAdminLogin /> : undefined}
      />
    </div>
  );
}
