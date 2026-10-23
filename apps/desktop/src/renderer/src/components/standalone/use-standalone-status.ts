import { useEffect, useState } from "react";
import type { StandaloneStatus } from "../../../../shared/standalone";

// 订阅主进程推送的单机模式状态；第一次推送到达前为 null。
export function useStandaloneStatus(): StandaloneStatus | null {
  const [status, setStatus] = useState<StandaloneStatus | null>(null);

  useEffect(() => window.desktopAPI.standalone.onStatus(setStatus), []);

  return status;
}
