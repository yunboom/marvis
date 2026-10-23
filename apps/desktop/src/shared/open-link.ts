/**
 * 没有网页端时分享给他人的站内链接：`marvis://open?path=<站内路径>`。
 * 构造（渲染进程）和解析（主进程）放在同一处，格式只有一份。
 */

/** 深链协议名，与主进程注册的系统协议一致。 */
export const DEEP_LINK_PROTOCOL = "marvis";

/** 打开站内路径的深链主机名。 */
export const OPEN_LINK_HOST = "open";

const OPEN_LINK_PATH_PARAM = "path";
const MAX_OPEN_LINK_PATH_LENGTH = 2_048;

// 登录页路径：导航适配器遇到它会直接登出，不能被外部链接触发。
const LOGIN_PATH = "/login";

/** 把站内路径（可带查询串和片段）编码成 marvis://open 深链。 */
export function buildOpenLinkUrl(path: string): string {
  return `${DEEP_LINK_PROTOCOL}://${OPEN_LINK_HOST}?${OPEN_LINK_PATH_PARAM}=${encodeURIComponent(path)}`;
}

/**
 * 从 marvis://open 深链里取出站内路径；不是合法站内路径时返回 null。
 *
 * 深链来自系统，任何网页都能触发，所以只接受以单个 `/` 开头的站内路径：
 * 拒绝 `//host`、绝对 URL、反斜杠、控制字符、空值和超长值。
 * 链接末尾的片段（如评论链接的 `#comment-xxx`）并入返回的路径。
 */
export function parseOpenLinkPath(url: URL): string | null {
  if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;
  if (url.hostname !== OPEN_LINK_HOST) return null;

  const path = url.searchParams.get(OPEN_LINK_PATH_PARAM);
  if (!path || path.length > MAX_OPEN_LINK_PATH_LENGTH) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex -- 控制字符（含制表、换行）会被 URL 解析器吞掉，可借此拼出 `//host`
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (isLoginPath(path)) return null;

  return `${path}${url.hash}`;
}

function isLoginPath(path: string): boolean {
  const end = path.search(/[?#]/);
  const pathname = end === -1 ? path : path.slice(0, end);

  return pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`;
}
