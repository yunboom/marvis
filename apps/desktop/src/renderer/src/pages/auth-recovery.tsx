import { useState } from "react";
import { useAuthStore } from "@marvis/core/auth";
import { Button } from "@marvis/ui/components/ui/button";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { useT } from "@marvis/views/i18n";
import { DragStrip } from "@marvis/views/platform";
import { ConnectServerScreen } from "../components/server/connect-server-screen";
import { useLogoutBeforeSwitch } from "../components/server/use-logout-before-switch";

export function DesktopAuthRecoveryPage({
  onRetry,
  isRetrying = false,
  canSwitchServer = false,
}: {
  onRetry?: () => void;
  isRetrying?: boolean;
  /** 主窗口里可以换一台服务器：连不上的服务器可能永远不会恢复，只能重试会卡住。 */
  canSwitchServer?: boolean;
}) {
  const { t } = useT("auth");
  const { t: tSettings } = useT("settings");
  const retryAuthentication = useAuthStore(
    (state) => state.retryAuthentication,
  );
  const logoutBeforeSwitch = useLogoutBeforeSwitch();
  const [switching, setSwitching] = useState(false);

  if (switching) {
    return (
      <ConnectServerScreen
        beforeSwitch={logoutBeforeSwitch}
        onBack={() => setSwitching(false)}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center text-center">
          <MarvisIcon bordered size="lg" />
          <h1 className="mt-6 text-title font-semibold">
            {t(($) => $.desktop.recovery.title)}
          </h1>
          <p className="mt-2 text-body text-muted-foreground">
            {t(($) => $.desktop.recovery.description)}
          </p>
          <div className="mt-6 flex gap-2">
            <Button
              disabled={isRetrying}
              onClick={onRetry ?? retryAuthentication}
            >
              {isRetrying
                ? t(($) => $.desktop.recovery.retrying)
                : t(($) => $.desktop.recovery.retry)}
            </Button>
            {canSwitchServer && (
              <Button variant="outline" onClick={() => setSwitching(true)}>
                {tSettings(($) => $.desktop.server.banner.switch)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
