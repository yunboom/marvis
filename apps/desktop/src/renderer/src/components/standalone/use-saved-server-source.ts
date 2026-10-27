import { useEffect, useState } from "react";
import type { ServerSource } from "../../../../shared/server-discovery";

// 已保存的服务器来源：undefined 表示还在读取，null 表示没有保存过选择（或读取失败）。
export function useSavedServerSource(): ServerSource | null | undefined {
  const [source, setSource] = useState<ServerSource | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    window.desktopAPI.server
      .current()
      .then((selected) => {
        if (!cancelled) setSource(selected?.source ?? null);
      })
      .catch(() => {
        // 读不到选择时按远程服务器处理。
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return source;
}
