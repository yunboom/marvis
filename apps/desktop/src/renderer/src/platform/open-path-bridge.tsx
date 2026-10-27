import { useEffect, useRef } from "react";
import { useNavigation } from "@marvis/views/navigation";

/**
 * 接收主进程下发的站内路径（深链 marvis://open?path=...），交给导航适配器。
 *
 * 路径已由主进程校验。走适配器的 push，所以别的工作区会切换标签组、
 * 过渡页面（邀请、新建工作区）进入窗口浮层，与应用内点击一致。
 * 主窗口外壳挂载后才订阅，登录或连接服务器之前到达的链接在主进程队列里等着。
 */
export function OpenPathBridge() {
  const { push } = useNavigation();
  // 适配器随当前标签地址变化而换新；ref 让主进程订阅不随每次导航重建。
  const pushRef = useRef(push);
  useEffect(() => {
    pushRef.current = push;
  }, [push]);

  useEffect(() => {
    return window.desktopAPI.onOpenPath((path) => {
      pushRef.current(path);
    });
  }, []);

  return null;
}
