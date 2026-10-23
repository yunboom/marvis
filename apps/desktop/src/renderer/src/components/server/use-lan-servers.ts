import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscoveredServer } from "../../../../shared/server-discovery";

// 订阅或重新查找后的查找窗口：窗口内界面显示“正在查找”。
export const LAN_SCAN_WINDOW_MS = 5000;

export interface LanServers {
  servers: DiscoveredServer[];
  scanning: boolean;
  rescan: () => void;
}

// 订阅局域网中发现的 Marvis 服务器。
// 同一个页面只应有一处订阅：预加载层不会向第二个订阅者重放当前列表。
export function useLanServers(): LanServers {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startScanWindow = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    setScanning(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setScanning(false);
    }, LAN_SCAN_WINDOW_MS);
  }, []);

  useEffect(() => {
    startScanWindow();
    const unsubscribe = window.desktopAPI.server.discover(setServers);

    return () => {
      unsubscribe();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [startScanWindow]);

  const rescan = useCallback(() => {
    window.desktopAPI.server.rescan();
    startScanWindow();
  }, [startScanWindow]);

  return { servers, scanning, rescan };
}
