import type { ReactNode } from "react";
import { DragStrip } from "@marvis/views/platform";

// 单机模式全窗口页面的外框：拖拽条 + 居中的两栏卡片，与连接页一致。
export function StandaloneScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-app-shell text-foreground">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center overflow-auto px-4 py-8">{children}</div>
    </div>
  );
}
