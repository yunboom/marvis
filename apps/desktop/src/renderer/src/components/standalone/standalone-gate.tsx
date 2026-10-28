import { useCallback, useEffect, useState, type ReactNode } from "react";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { SERVER_SOURCE_STANDALONE } from "../../../../shared/server-discovery";
import { STANDALONE_PHASE_RUNNING } from "../../../../shared/standalone";
import { ConnectServerScreen } from "../server/connect-server-screen";
import { useLogoutBeforeSwitch } from "../server/use-logout-before-switch";
import { PREPARE_MODE_GATE, StandalonePrepareScreen } from "./standalone-prepare-screen";
import { useStandaloneStatus } from "./use-standalone-status";

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <MarvisIcon className="size-12 animate-pulse" />
    </div>
  );
}

// 主窗口的入口：选的是单机模式、本机服务还没运行时，先显示启动或失败的状态页，运行后才进入应用。
export function StandaloneGate({ children }: { children: ReactNode }) {
  // undefined：还在读取已保存的选择。
  const [source, setSource] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.desktopAPI.server
      .current()
      .then((selected) => {
        if (!cancelled) setSource(selected?.source ?? null);
      })
      .catch(() => {
        // 读不到选择时按远程服务器处理，由应用自己的连接状态提示。
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (source === undefined) return <LoadingScreen />;
  if (source !== SERVER_SOURCE_STANDALONE) return <>{children}</>;

  return <StandaloneRunningGate>{children}</StandaloneRunningGate>;
}

function StandaloneRunningGate({ children }: { children: ReactNode }) {
  const status = useStandaloneStatus();
  // 运行过一次后不再拦截：之后的重启、更新由应用内的连接状态提示，避免整个应用被卸载。
  const [reachedRunning, setReachedRunning] = useState(false);
  // 本机服务起不来时可以换一台服务器，否则只能重试会卡住。
  const [switching, setSwitching] = useState(false);
  const logoutBeforeSwitch = useLogoutBeforeSwitch();
  const running = status?.phase === STANDALONE_PHASE_RUNNING;

  // 换到别的服务器前：退出旧账号，并停掉本机服务（可能还在反复启动）。
  const beforeSwitch = useCallback(async () => {
    await logoutBeforeSwitch();
    await window.desktopAPI.standalone.stop();
  }, [logoutBeforeSwitch]);

  useEffect(() => {
    if (running) setReachedRunning(true);
  }, [running]);

  if (running || reachedRunning) return <>{children}</>;
  if (status === null) return <LoadingScreen />;
  if (switching) {
    return <ConnectServerScreen beforeSwitch={beforeSwitch} onBack={() => setSwitching(false)} />;
  }

  return (
    <StandalonePrepareScreen status={status} mode={PREPARE_MODE_GATE} onSwitchServer={() => setSwitching(true)} />
  );
}
