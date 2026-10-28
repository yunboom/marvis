# 生产部署

把 origin/main 的最新提交部署到 prototype 实例（https://omniai.shoplazza.site/marvis）。

```bash
make deploy-prod-check   # 只跑检查，不改动服务器
make deploy-prod         # 部署
```

## 前提

- 本机能用 `ssh j` 登录跳板机（密钥登录），装有 `expect` 和已登录的 `gh`。
- 在 `main` 分支上，工作区干净，`HEAD` 等于 `origin/main`。
- 该提交推送到 main 时触发的那次 CI 已经通过；CI 未跑完或失败都会拒绝部署。每日定时跑的全量 CI 测试范围更大，不作为部署门槛。

## 流程

| 文件 | 在哪里执行 | 做什么 |
| --- | --- | --- |
| `prod.sh` | 本机 | 检查分支、工作区、提交和 CI，然后调用 `jump.exp` |
| `jump.exp` | 本机 | 登录跳板机，在菜单输入 `prototype` 进入服务器，把仓库检出到 origin/main 最新提交后以 root 执行 `server.sh`，把它的退出码作为本地结果 |
| `server.sh` | 服务器 | 再次确认提交是 origin/main 最新提交，按提交号构建三个镜像（前缀 `/marvis`），备份数据库，切换容器，检查健康；失败时切回上一版镜像 |
| `prod.env.example` | 服务器 | 生产配置模板，首次部署时复制为 `/root/apps/marvis/.env` 并生成密钥 |

跳板机不接受不带终端的远程命令，也不允许直连资产，所以 `jump.exp` 模拟人工操作菜单。跳板机的提示符改了只需要调整这个文件。

服务器上执行的 `server.sh` 总是 origin/main 上的版本，本地改动这几个脚本不会影响服务器上的校验。

## 服务器目录

```
/root/apps/marvis/
├── repo/          # 仓库，每次部署检出到 origin/main 最新提交
├── .env           # 生产配置，只在服务器上，权限 600
├── backups/       # 每次部署前的数据库备份，保留最近 10 份
├── releases.log   # 部署成功的提交号，回滚依据
└── deploy.lock    # 部署锁，同一时刻只允许一次部署
```

## 首次部署后要手动做的事

1. 编辑 `/root/apps/marvis/.env`，填写飞书登录、邮件、大模型等配置，然后重新部署一次。
2. 备份 `/root/nginx/conf.d/domain.conf` 为 `domain.conf.bak.<时间>`，在 443 的 server 块里加入 `/marvis/`、`/marvis/ws`、`/marvis/docs` 三段 location（见仓库根目录 `SELF_HOSTING_ADVANCED.md` 的 Path Prefix 一节，代理目标换成 `host.docker.internal`），然后执行 `docker exec nginx-proxy nginx -t && docker exec nginx-proxy nginx -s reload`。注意 `/root/nginx/domain.conf` 是旧副本，改它不会生效。
3. 在飞书开放平台登记重定向地址 `https://omniai.shoplazza.site/marvis/auth/callback`。

## 回滚与数据库

健康检查失败时自动切回 `releases.log` 中上一次成功的版本。回滚只切换镜像；如果新版本已经执行了数据库迁移，旧版本可能无法正常工作，此时脚本会输出部署前备份的路径，是否恢复数据库由人决定：

```bash
cd /root/apps/marvis/repo
docker compose --env-file ../.env -f docker-compose.selfhost.yml exec -T postgres \
  pg_restore -U marvis -d marvis --clean --if-exists < ../backups/<备份文件>.dump
```
