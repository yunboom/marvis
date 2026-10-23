import { buildOpenLinkUrl } from "../../../shared/open-link";

/**
 * 站内路径对应的可分享地址。
 *
 * 有网页端时是网页端地址；appUrl 为空串表示服务器没有网页端，
 * 改用 marvis://open 深链，收到的人点开会在桌面端里打开同一页面。
 */
export function buildShareableUrl(appUrl: string, path: string): string {
  if (appUrl) return `${appUrl}${path}`;
  // 共享视图用 getShareableUrl("/") 探测网页端 origin（useAppOrigin）。深链的
  // origin 是 "null"，会被当成有效 origin 而让相对链接解析失败；根路径本就不是
  // 值得分享的页面，原样返回让探测落空。
  if (path === "/") return path;

  return buildOpenLinkUrl(path);
}
