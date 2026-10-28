# 部署必须带网页端（决策记录）

## 1. 撤回「不部署网页端、桌面端直连 API」（2026-10-28）

- 定了什么：自托管 / 生产部署时网页端必须和后端一起部署。桌面端的 Google、飞书登录走网页登录页（`<网页地址><路径前缀>/auth/callback`），复制链接生成网页地址。
- 范围：只改部署说明和文档，代码保留「没有网页端」的兜底（`desktop-start` / `desktop-callback`、`lark_desktop_login`、`marvis://open` 链接、隐藏分享邀请），供本地开发和桌面端单机模式使用。
- 已改：`apps/docs` 的 `desktop-app*.mdx`、`self-host-quickstart*.mdx`（五种语言），`.env.example` 飞书段落注释。`docker-compose.selfhost.yml` 本来就带 `frontend` 服务，未改。
- 生产配置：`MARVIS_APP_URL` 设为非 `localhost` 的网页地址；飞书后台登记 `/auth/callback` 与 H5 可信域名；`MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI` 留空。
- 本地开发：`MARVIS_APP_URL` 是 `localhost` 时桌面端按没有网页端处理，`MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI` 要指向后端端口（`PORT`），不是前端端口。
- 没做：删除无网页端的代码路径。若以后单机模式也改为内置网页端，再整体删除。
