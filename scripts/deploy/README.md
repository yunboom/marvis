# 生产部署

把 origin/main 的最新提交部署到 prototype 实例（https://omniai.shoplazza.site/marvis）。

```bash
make deploy-prod-check   # 只跑检查，不改动服务器
make deploy-prod         # 部署
```

## 前提

- 本机能用 `ssh j` 登录跳板机（密钥登录），装有 `expect` 和已登录的 `gh`。
- 在 `main` 分支上，工作区干净，`HEAD` 等于 `origin/main`。
- 该提交推送到 main 时触发的那次 CI 已经跑完，且其中的测试和构建作业（`backend`、`frontend-build`、`frontend-test`、`frontend-views-test`）全部通过或被跳过（没改到对应范围时 CI 会跳过）。前端质量检查这类代码规范作业不作为部署门槛，但仍要按规范修复；每日定时跑的全量 CI 也不作为门槛。

## 流程

| 文件 | 在哪里执行 | 做什么 |
| --- | --- | --- |
| `prod.sh` | 本机 | 检查本地的 `.env.prod`、分支、工作区、提交和 CI，然后调用 `jump.exp` |
| `jump.exp` | 本机 | 登录跳板机，在菜单输入 `prototype` 进入服务器，上传 `.env.prod`，把仓库检出到 origin/main 最新提交后以 root 执行 `server.sh`，把它的退出码作为本地结果 |
| `.github/workflows/prod-images.yml` | GitHub Actions | 每次推送到 main 时构建后端、网页端、文档站三个镜像，路径前缀取工作流里的 `BASE_PATH`（`/marvis`），同时写进三个镜像，推送为 `ghcr.io/yunboom/<镜像>:prod-<提交号>` |
| `server.sh` | 服务器 | 再次确认提交是 origin/main 最新提交，从 ghcr 拉取这个提交的三个镜像，备份数据库，切换容器，检查健康；失败时切回上一版镜像 |
| `prod.env.example` | 本机 | 生产配置模板，首次部署时复制为主工作区根目录的 `.env.prod` 并生成密钥 |

## 生产配置

生产配置以本地主工作区根目录的 `.env.prod` 为准，它被 git 忽略，不会提交。第一次执行 `make deploy-prod` 时脚本从模板创建它并生成 `JWT_SECRET`、`POSTGRES_PASSWORD`、`MARVIS_VCS_SECRET_KEY`，然后停下，填好飞书登录等配置后重新执行。

每次部署（包括 `make deploy-prod-check`）都会上传它：正式部署时覆盖服务器的 `/root/apps/marvis/.env`，内容有变化时把旧版本保存到 `/root/apps/marvis/env-backups/`；检查模式只报告会不会变化。上传时关闭终端回显，密钥不会打印到本地输出，但 JumpServer 的会话审计可能会记录这次输入，和登录后用编辑器修改一样。

`.env.prod` 丢失后重新生成会得到新的密钥，旧的数据库密码和加密密钥就对不上了，所以要自己保留一份备份；服务器的 `env-backups/` 里也有历史版本。

跳板机不接受不带终端的远程命令，也不允许直连资产，所以 `jump.exp` 模拟人工操作菜单。跳板机的提示符改了只需要调整这个文件。

镜像不在服务器上构建：prototype 是 CentOS 7（内核 3.10），Node 22 在它的 Docker 里执行 `pnpm install` 会报 `EPERM: operation not permitted, write`（Node 20 正常，Node 22 运行时也正常），所以构建放在 GitHub Actions，服务器只拉取。部署前除了 CI，还要求这个提交的 `Production images` 工作流成功。

服务器上执行的 `server.sh` 总是 origin/main 上的版本，本地改动这几个脚本不会影响服务器上的校验。

## 服务器目录

```
/root/apps/marvis/
├── repo/          # 仓库，每次部署检出到 origin/main 最新提交
├── .env           # 生产配置，每次部署从本地 .env.prod 上传，权限 600
├── env-backups/   # .env 被覆盖前的历史版本
├── backups/       # 每次部署前的数据库备份，保留最近 10 份
├── releases.log   # 部署成功的提交号，回滚依据
└── deploy.lock    # 部署锁，同一时刻只允许一次部署
```

## 首次部署后要手动做的事

1. `Production images` 工作流第一次跑完后，在 GitHub 上把新建的 `marvis-docs` 容器包设为公开（Package settings → Change visibility）。`marvis-backend`、`marvis-web` 已经是公开的；包是私有的时候服务器拉取需要登录凭证。
2. 备份 `/root/nginx/conf.d/domain.conf` 为 `domain.conf.bak.<时间>`，在 443 的 server 块里加入 `/marvis/`、`/marvis/ws`、`/marvis/docs` 三段 location（见仓库根目录 `SELF_HOSTING_ADVANCED.md` 的 Path Prefix 一节，代理目标换成 `host.docker.internal`），然后执行 `docker exec nginx-proxy nginx -t && docker exec nginx-proxy nginx -s reload`。注意 `/root/nginx/domain.conf` 是旧副本，改它不会生效。
3. 在飞书开放平台登记重定向地址 `https://omniai.shoplazza.site/marvis/auth/callback`。

## 回滚与数据库

健康检查失败时自动切回 `releases.log` 中上一次成功的版本。回滚只切换镜像；如果新版本已经执行了数据库迁移，旧版本可能无法正常工作，此时脚本会输出部署前备份的路径，是否恢复数据库由人决定：

```bash
cd /root/apps/marvis/repo
docker compose --env-file ../.env -f docker-compose.selfhost.yml exec -T postgres \
  pg_restore -U marvis -d marvis --clean --if-exists < ../backups/<备份文件>.dump
```
