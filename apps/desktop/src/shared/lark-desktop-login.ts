/**
 * 没有网页端时的桌面端飞书登录：渲染进程请求主进程开始登录，
 * 主进程生成一次性 nonce 并用浏览器打开服务端的飞书登录地址。
 */

/** 渲染进程请求主进程开始桌面端飞书登录的 IPC 通道。 */
export const LARK_DESKTOP_LOGIN_START_CHANNEL = "auth:lark-desktop-login-start";
