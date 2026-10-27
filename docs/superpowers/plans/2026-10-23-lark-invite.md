# 飞书邀请 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员或智能体把工作区邀请卡片发到飞书群或个人，点击“加入工作区”的人直接成为成员。

**Architecture:** 复用飞书登录的自建应用：服务端用它的机器人发卡片，并用 `integrations/lark` 现有的长连接代码起一条只收卡片点击的连接。邀请存在新表 `lark_invite`，点击加入复用从 `JoinByShareLink` 抽出来的成员写入逻辑。CLI 新增 `marvis workspace lark-invite`，前端在成员页加“飞书邀请”视图和发送弹窗。

**Tech Stack:** Go（chi、sqlc、pgx/v5、gorilla websocket）、PostgreSQL、cobra；TypeScript（React、TanStack Query、zod、i18next）。

**Spec:** `docs/superpowers/specs/2026-10-23-lark-invite-design.md`；设计稿画布 30–34 号画板 https://claude.ai/artifact/8JtMci5WWr68cixGLKptzZ

## Global Constraints

- 工作目录：worktree `/Users/mayunpeng/GolandProjects/marvis/.claude/worktrees/lark-invite`，分支 `feat/lark-invite`。首次跑 Go 测试前执行一次 `make setup-worktree`；跑测试用 `make env-exec ARGS="-- bash -c 'cd server && go test ./internal/... -run <Name> -count=1'"`。
- 不修改 `scripts/dev-env.sh`。
- Go module：`github.com/yunboom/marvis/server`。改完的 Go 文件跑 `gofmt -w` 和 `goimports -local github.com/yunboom/marvis/server -w`，import 分三组：标准库 / 第三方 / 本仓库。
- 代码注释用中文；错误消息、日志用英文，错误消息小写开头、不以标点结尾；导出标识符要有以名字开头的 doc 注释。
- 无法在本地处理的错误用 `github.com/pkg/errors` 包装（`errors.Wrapf` 带关键 id，`errors.WithStack` 无额外信息）往上抛；校验类、可预期的 4xx 不包装。
- 业务词表（状态、目标类型、ID 类型、错误码、卡片动作）定义成具名常量，比较和 SQL 参数都用常量。
- 不在 for 循环里串行调用外部资源；飞书发消息没有批量接口，多接收方用有上限的并发（上限 `larkInviteSendConcurrency = 4`），并在注释里写明原因。
- 迁移：不加外键；所有索引（含主键）用 `CREATE [UNIQUE] INDEX CONCURRENTLY`，每个并发建索引的语句单独一个迁移文件；主键按仓库约定“先建唯一索引、再 `ADD CONSTRAINT ... PRIMARY KEY USING INDEX`”。改完 SQL 跑 `make sqlc`。
- 产品文案（卡片、提示、界面）：中性、简短、陈述式，不写口语化安抚，不加括号补充。界面新增文案五种语言都要有（`packages/views/locales/{en,zh-Hans,ja,ko,fr}/settings.json`），过 `parity.test.ts`。
- API 响应进前端必须经过 zod schema 和 `parseWithFallback`，新增 schema 要带畸形响应测试。
- 单测不调用真实飞书：飞书接口一律用 `httptest` 或接口桩。
- 新开关 `MARVIS_LARK_INVITE_ENABLED`，默认关闭；可选 `MARVIS_DESKTOP_DOWNLOAD_URL`，为空时卡片不显示“下载 Marvis”按钮。
- 每个任务结束提交一次，提交信息用英文 conventional commit，结尾带 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。

## Review Focus

1. **同一个人快速连点两次“加入工作区”**：只产生一个成员，`use_count` 只加 1，第二次回“你已在 {工作区} 中”。测试在 Task 7。
2. **点卡片时邀请或工作区已不存在**（工作区被删、点击被推到另一个部署）：回“邀请已失效”，不改卡片，不返回 500。测试在 Task 7。
3. **点击时飞书通讯录接口很慢**：整个处理在 2.5 秒内回应；超时回“加入失败，请稍后重试”，不留下半个成员。测试在 Task 7。
4. **附言、群名、人名里带 Markdown 或飞书标签**（`**`、`<at id=all>`、`[x](url)`）：卡片里按纯文本显示，不触发 @所有人。测试在 Task 5。
5. **发卡片的管理员后来被移出工作区**：已发出的卡片在有效期内照常可用（和分享链接一致），卡片上的发送人名字照常显示。测试在 Task 7。

## 本计划相对设计文档的裁定

- **席位容量**：只有连了 Marvis Cloud（`h.SeatCapacity != nil`）才启用席位容量，Marvis 自托管不会打开。飞书邀请在席位容量开启时整体不可用（返回 `lark_not_configured`），不为它新增席位意图类型。设计文档已同步修改。
- **卡片已加入人数只显示文字**“{n} 人已加入”，不放头像列表，避免依赖未验证的卡片组件。
- **首次进入提示**的“只出现一次”记在服务端：`lark_invite_join.welcomed_at`。

## 文件结构

服务端：
- `server/migrations/593_lark_invite.{up,down}.sql` 至 `599_*`：两张表和索引。
- `server/pkg/db/queries/lark_invite.sql`：sqlc 查询。
- `server/internal/integrations/lark/invite_api.go`：飞书邀请用到的开放平台接口（群信息、机器人所在群、用户资料、邮箱换 open_id、发卡片、改卡片）和错误码归类。
- `server/internal/integrations/lark/ws_connector.go`、`ws_frame.go`：卡片回调帧的处理和回应帧。
- `server/internal/integrations/lark/invite_connection.go`：登录应用长连接的守护循环（断线退避重连）。
- `server/internal/handler/member_admit.go`：从 `JoinByShareLink` 抽出的成员写入公共函数。
- `server/internal/handler/lark_invite_card.go`：卡片 JSON 和点击回应的构造。
- `server/internal/handler/lark_invite.go`：HTTP 接口（发送、列表、详情、撤销、列群、查人、状态、欢迎提示）。
- `server/internal/handler/lark_invite_action.go`：卡片点击处理。
- `server/internal/handler/auth.go`：飞书登录同步头像。
- `server/cmd/server/router.go`、`main.go`：路由和开关接线。
- `server/cmd/marvis/cmd_lark_invite.go`：CLI。

前端：
- `packages/core/types/workspace.ts`、`packages/core/api/schemas.ts`、`packages/core/api/client.ts`、`packages/core/workspace/queries.ts`：类型、schema、API 方法、查询。
- `packages/views/settings/components/lark-invites-view.tsx`：成员页的飞书邀请列表。
- `packages/views/settings/components/lark-invite-send-dialog.tsx`：发送弹窗。
- `packages/views/settings/components/members-tab.tsx`：接入新视图。
- `packages/views/layout/lark-invite-welcome.tsx`：首次进入提示，挂在 `dashboard-layout.tsx`。

---

### Task 1: 飞书邀请用到的开放平台接口

**Files:**
- Create: `server/internal/integrations/lark/invite_api.go`
- Test: `server/internal/integrations/lark/invite_api_test.go`

**Interfaces:**
- Consumes: 现有 `httpAPIClient.doAuthedJSON`、`InstallationCredentials`、`PatchInteractiveCard`、`larkAPIStatusError`（`http_client.go`）。
- Produces:
  ```go
  type InviteChat struct { ChatID, Name, AvatarURL string; MemberCount int }
  type InviteUser struct { OpenID, Name, AvatarURL, Email, EnterpriseEmail, TenantKey string }
  type InviteReceiveIDType string // 常量 InviteReceiveChatID = "chat_id"、InviteReceiveOpenID = "open_id"
  type InviteAPIClient interface {
      GetChat(ctx context.Context, creds InstallationCredentials, chatID string) (InviteChat, error)
      ListBotChats(ctx context.Context, creds InstallationCredentials) ([]InviteChat, error)
      GetUser(ctx context.Context, creds InstallationCredentials, openID string) (InviteUser, error)
      LookupOpenIDByEmail(ctx context.Context, creds InstallationCredentials, email string) (string, error)
      SendInviteCard(ctx context.Context, creds InstallationCredentials, idType InviteReceiveIDType, receiveID, cardJSON, dedupeKey string) (string, error)
      PatchInviteCard(ctx context.Context, creds InstallationCredentials, messageID, cardJSON string) error
  }
  func NewInviteAPIClient(cfg HTTPClientConfig) InviteAPIClient
  // 邀请错误码常量：InviteErrBotNotInChat="bot_not_in_chat"、InviteErrUserNotFound="user_not_found"、
  // InviteErrUserNotInScope="user_not_in_app_scope"、InviteErrOpenIDCrossApp="open_id_cross_app"
  func ClassifyInviteError(err error) string // 归不进上述四类时返回 ""
  ```

- [ ] **Step 1: 写失败的测试**（`httptest.Server` 充当飞书，`HTTPClientConfig{BaseURL: srv.URL}`，token 接口返回固定 tenant token）

  - `TestInviteAPI_GetChat`：`GET /open-apis/im/v1/chats/oc_1` 返回 `name="设计组"`、`avatar`、`user_count="12"`，断言 `InviteChat{ChatID:"oc_1", Name:"设计组", MemberCount:12}`。
  - `TestInviteAPI_ListBotChats_Paginates`：两页（`has_more=true` + `page_token`），断言合并后 3 个群、第二次请求带 `page_token`。
  - `TestInviteAPI_GetUser`：`GET /open-apis/contact/v3/users/ou_1?user_id_type=open_id` 返回 `name`、`avatar.avatar_240`、`email`、`enterprise_email`，断言字段映射。
  - `TestInviteAPI_LookupOpenIDByEmail`：`POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id` 请求体 `{"emails":["a@x.com"]}`；有结果返回 open_id，`user_list[0].user_id` 为空时返回的错误经 `ClassifyInviteError` 得到 `user_not_found`。
  - `TestInviteAPI_SendInviteCard`：断言请求 `POST /open-apis/im/v1/messages?receive_id_type=open_id`，body 的 `msg_type="interactive"`、`content` 为卡片 JSON、`uuid` 为 dedupeKey（dedupeKey 为空时不带 `uuid`），返回 `message_id`。
  - `TestClassifyInviteError`：表驱动，飞书错误码 `230002`→`bot_not_in_chat`，`230013`→`user_not_in_app_scope`，`99992361`→`open_id_cross_app`，`99992360`、`41050`→`user_not_found`，其他→`""`。

- [ ] **Step 2: 运行确认失败**：`cd server && go test ./internal/integrations/lark -run 'TestInviteAPI|TestClassifyInviteError' -count=1`，预期编译失败（类型未定义）。

- [ ] **Step 3: 实现** `invite_api.go`：在同包的 `httpAPIClient` 上加方法，`NewInviteAPIClient` 复用 `NewHTTPAPIClient` 的构造并断言为 `InviteAPIClient`。飞书错误码按 Task 11 实测结果可能需要调整，统一定义为具名常量放在文件顶部。`PatchInviteCard` 直接调用已有的 `PatchInteractiveCard`。

- [ ] **Step 4: 运行确认通过**：同 Step 2 命令，预期 PASS。

- [ ] **Step 5: 提交** `feat(lark): open-platform calls for Feishu invite cards`

### Task 2: 长连接处理卡片回调

**Files:**
- Modify: `server/internal/integrations/lark/ws_frame.go`（新增回应帧）
- Modify: `server/internal/integrations/lark/ws_connector.go`（`WSConnectorConfig.CardHandler`、帧循环分支）
- Create: `server/internal/integrations/lark/invite_connection.go`
- Test: `server/internal/integrations/lark/ws_connector_test.go`、`server/internal/integrations/lark/invite_connection_test.go`

**Interfaces:**
- Consumes: 现有 `Frame`、`FrameHeaderTypeKey`、`FrameHeaderTypeCard`、`NewAckFrame`、`WSLongConnConnector.Run`。
- Produces:
  ```go
  // CardActionHandler 处理一次卡片回调，返回要回给飞书的回应 JSON（toast / card）。
  type CardActionHandler func(ctx context.Context, payload []byte) ([]byte, error)
  // WSConnectorConfig 新增字段：CardHandler CardActionHandler；CardHandlerTimeout time.Duration（默认 2500ms）
  func NewCardResponseFrame(inbound *Frame, response []byte) *Frame
  // InviteRunner 是守护循环驱动的连接，*WSLongConnConnector 满足它；测试注入假实现。
  type InviteRunner interface {
      Run(ctx context.Context, inst Installation, emit EventEmitter) error
  }
  type InviteConnection struct { /* 内部字段 */ }
  type InviteConnectionConfig struct {
      Connector InviteRunner
      AppID     string
      Logger    *slog.Logger
      MinBackoff, MaxBackoff time.Duration // 默认 1s、60s
  }
  func NewInviteConnection(cfg InviteConnectionConfig) *InviteConnection
  func (c *InviteConnection) Run(ctx context.Context) // 阻塞直到 ctx 结束，断线按退避重连
  func NewDropAllFrameDecoder() FrameDecoder // 事件帧一律不处理，只 ACK
  ```

- [ ] **Step 1: 写失败的测试**

  - `TestWSConnector_CardFrameCallsHandlerAndRespondsWithData`：沿用现有 connector 测试的假 WS 服务端，下发 `type=card` 的数据帧，payload 为卡片回调 JSON；`CardHandler` 返回 `{"toast":{"type":"success","content":"ok"}}`。断言：handler 收到原 payload；回写的帧 headers 与入帧相同；payload 解析为 `{"code":200,...,"data":"<base64>"}`，`data` base64 解码后等于 handler 返回值。
  - `TestWSConnector_CardFrameHandlerErrorStillAcks`：handler 返回错误，断言回 `code=200` 且 `data` 为空，连接不断开。
  - `TestWSConnector_CardFrameWithoutHandlerAcks`：`CardHandler` 为 nil 时卡片帧按现有逻辑 ACK 200。
  - `TestInviteConnection_RetriesWithBackoff`：注入一个第一次 `Run` 立刻返回错误、第二次阻塞到 ctx 取消的假 `InviteRunner`，`MinBackoff` 设为 20ms，断言第二次调用发生在 20ms 之后，`ctx` 取消后 `InviteConnection.Run` 返回。

- [ ] **Step 2: 运行确认失败**：`go test ./internal/integrations/lark -run 'TestWSConnector_CardFrame|TestInviteConnection' -count=1`。

- [ ] **Step 3: 实现**
  - `ws_connector.go` 帧循环：在分片重组之后、交给 `FrameDecoder` 之前，判断 `frame.HeaderValue(FrameHeaderTypeKey) == FrameHeaderTypeCard && c.cfg.CardHandler != nil`：用 `CardHandlerTimeout` 包一层 ctx 调 handler，写 `NewCardResponseFrame`，`continue`。handler 出错时记 warn 日志并写 `NewCardResponseFrame(frame, nil)`。
  - `NewCardResponseFrame`：payload 为 `{"code":200,"headers":null,"data":<response 的 base64>}`，`response` 为 nil 时 `data` 为 `null`。格式以 Task 11 实测为准。
  - `invite_connection.go`：内存里构造 `Installation{AppID: cfg.AppID}`，循环调用 `Run(ctx, inst, noopEmit)`，返回后按 `MinBackoff` 起步、翻倍、不超过 `MaxBackoff` 等待；连上超过一分钟后退避复位。

- [ ] **Step 4: 运行确认通过**，并跑整个包确认现有测试不回归：`go test ./internal/integrations/lark -count=1`。

- [ ] **Step 5: 提交** `feat(lark): answer card callbacks over the long connection`

### Task 3: 数据表和查询

**Files:**
- Create: `server/migrations/593_lark_invite.up.sql` / `.down.sql`（两张表）
- Create: `594_lark_invite_pkey_uidx`、`595_lark_invite_primary_key`、`596_lark_invite_workspace_idx`、`597_lark_invite_idempotency_uidx`、`598_lark_invite_join_uidx`、`599_lark_invite_join_user_idx`（各自 `.up.sql` / `.down.sql`）
- Create: `server/pkg/db/queries/lark_invite.sql`
- Regenerate: `server/pkg/db/generated/*`（`make sqlc`）
- Test: `server/internal/handler/lark_invite_db_test.go`

**Interfaces:**
- Produces（sqlc 生成）：
  - 表 `lark_invite`：`id uuid NOT NULL DEFAULT gen_random_uuid()`，`workspace_id uuid NOT NULL`，`target_type text NOT NULL CHECK (target_type IN ('chat','user'))`，`target_id text NOT NULL`，`target_id_type text NOT NULL CHECK (target_id_type IN ('chat_id','open_id','email'))`，`target_open_id text`，`target_name text NOT NULL DEFAULT ''`，`target_avatar_url text`，`role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'))`，`max_uses int`，`use_count int NOT NULL DEFAULT 0`，`expires_at timestamptz NOT NULL`，`revoked_at timestamptz`，`note text NOT NULL DEFAULT ''`，`idempotency_key text`，`lark_message_id text`，`sent_by_user_id uuid NOT NULL`，`sent_by_agent_id uuid`，`created_at timestamptz NOT NULL DEFAULT now()`。
  - 表 `lark_invite_join`：`invite_id uuid NOT NULL`，`workspace_id uuid NOT NULL`，`user_id uuid NOT NULL`，`lark_open_id text NOT NULL`，`joined_at timestamptz NOT NULL DEFAULT now()`，`welcomed_at timestamptz`。
  - 索引：`lark_invite_pkey_uidx (id)` 并挂为主键；`idx_lark_invite_workspace (workspace_id, created_at DESC)`；`idx_lark_invite_idempotency` 唯一 `(workspace_id, target_id, idempotency_key) WHERE idempotency_key IS NOT NULL`；`idx_lark_invite_join_invite_user` 唯一 `(invite_id, user_id)`；`idx_lark_invite_join_user_workspace (user_id, workspace_id)`。
  - 查询：`CreateLarkInvite :one`、`GetLarkInviteInWorkspace :one`（id + workspace_id）、`GetLarkInvite :one`（id）、`GetLarkInviteByIdempotencyKey :one`、`SetLarkInviteMessageID :exec`、`DeleteLarkInvite :exec`、`ListLarkInvitesByWorkspace :many`（`LIMIT 200`，按 `created_at DESC`）、`RevokeLarkInvite :one`（`revoked_at` 为空时置为 now，返回行）、`ClaimLarkInviteUse :one`（条件更新：未撤销、未过期、`max_uses IS NULL OR use_count < max_uses`，`use_count+1`，返回行）、`CreateLarkInviteJoin :exec`、`ListLarkInviteJoinsByInviteIDs :many`（`invite_id = ANY($1)`，带 `user.name`、`user.email`、`user.avatar_url`，按 `joined_at DESC`）、`GetPendingLarkInviteWelcome :one`（user_id + workspace_id + `welcomed_at IS NULL`，带邀请的 role 和发送人名字）、`MarkLarkInviteWelcomed :exec`。

- [ ] **Step 1: 写迁移和查询**，`make sqlc`，确认生成代码编译：`cd server && go build ./...`。

- [ ] **Step 2: 写失败的测试**（DB 测试，用 `testPool`、`testWorkspaceID`、`testUserID`）
  - `TestClaimLarkInviteUse_RespectsLimitsAndRevocation`：`max_uses=1` 第一次成功、第二次 `pgx.ErrNoRows`；已撤销、已过期的都 `ErrNoRows`；`max_uses` 为空时可多次。
  - `TestLarkInviteIdempotencyKey_Unique`：同 workspace、同 target、同 key 第二次插入违反唯一约束；key 为空不受限。

- [ ] **Step 3: 运行确认失败再通过**：`make env-exec ARGS="-- bash -c 'cd server && go run ./cmd/migrate up && go test ./internal/handler -run '"'"'TestClaimLarkInviteUse|TestLarkInviteIdempotencyKey'"'"' -count=1'"`。

- [ ] **Step 4: 提交** `feat(db): tables for Feishu invite cards`

### Task 4: 抽出成员写入公共函数

**Files:**
- Create: `server/internal/handler/member_admit.go`
- Modify: `server/internal/handler/share_link.go`（`JoinByShareLink` 改为调用公共函数）
- Test: 现有 `server/internal/handler/share_link_test.go` 全部保持通过；新增 `server/internal/handler/member_admit_test.go`

**Interfaces:**
- Produces:
  ```go
  var errAdmitAlreadyMember = errors.New("user is already a member of this workspace")
  var errAdmitClaimRejected = errors.New("admission claim rejected")
  type admitMemberInput struct {
      WorkspaceID    pgtype.UUID
      User           db.User
      Role           string
      CapacityToken  uuid.UUID // 席位容量关闭时为 uuid.Nil
      CapacityAction string
      // Claim 在同一事务里占用一次名额；名额用完、过期、撤销时返回 errAdmitClaimRejected。
      Claim     func(ctx context.Context, qtx *db.Queries) error
      // AfterCreate 在同一事务里、成员写入之后执行（飞书邀请用来写 lark_invite_join），可为 nil。
      AfterCreate func(ctx context.Context, qtx *db.Queries, member db.Member) error
      Source      string // 日志用，如 "share_link"、"lark_invite"
  }
  func (h *Handler) admitWorkspaceMember(ctx context.Context, in admitMemberInput) (db.Member, error)
  ```
  事务内顺序与现有 `JoinByShareLink` 一致：Claim → 已是成员检查 → 结清同邮箱待接受邀请 → `CreateMember` → `MarkUserOnboarded` → 席位意图确认 → AfterCreate → 提交；提交后确认席位、发布 `member_added` / `invitation_accepted` 事件、`notifyDaemonWorkspacesChanged`。`CreateMember` 唯一冲突返回 `errAdmitAlreadyMember` 并补偿席位意图。

- [ ] **Step 1: 写失败的测试** `TestAdmitWorkspaceMember_ClaimRejectedLeavesNoMember`（Claim 返回 `errAdmitClaimRejected` 时不写成员）、`TestAdmitWorkspaceMember_AfterCreateErrorRollsBack`（AfterCreate 出错时成员和 Claim 都回滚）。
- [ ] **Step 2: 运行确认失败**：`go test ./internal/handler -run TestAdmitWorkspaceMember -count=1`。
- [ ] **Step 3: 实现** `member_admit.go`，把 `JoinByShareLink` 的事务段替换为调用它，HTTP 状态码和响应体保持原样。
- [ ] **Step 4: 运行** `go test ./internal/handler -run 'TestAdmitWorkspaceMember|ShareLink' -count=1`，全部通过。
- [ ] **Step 5: 提交** `refactor(handler): share the member admission transaction`

### Task 5: 卡片内容

**Files:**
- Create: `server/internal/handler/lark_invite_card.go`
- Test: `server/internal/handler/lark_invite_card_test.go`

**Interfaces:**
- Produces:
  ```go
  const larkInviteActionJoin = "join_workspace" // 按钮回传值里的 action
  type larkInviteCardState string // larkInviteCardActive / larkInviteCardJoined / larkInviteCardInvalid
  type larkInviteCardView struct {
      State          larkInviteCardState
      InviteID       string
      WorkspaceName  string
      InviterName    string
      AgentName      string // 智能体代发时非空
      Role           string
      Note           string
      ExpiresAt      time.Time
      JoinedCount    int
      InvalidReason  string // 失效时的底部说明，如“10 月 20 日已过期”“已撤销”
      DownloadURL    string // 为空时不显示下载按钮
  }
  func buildLarkInviteCard(v larkInviteCardView) (string, error)        // 卡片 JSON（schema 2.0，config.update_multi=true）
  func buildLarkInviteToast(kind, content string) []byte                 // {"toast":{"type":kind,"content":content}}
  func buildLarkInviteCardResponse(kind, content string, card string) []byte // toast + {"card":{"type":"raw","data":<card>}}
  ```
  文案（具名常量）：标题“工作区邀请”；正文“**{发送人}** 邀请你加入工作区 **{工作区}**”，智能体代发为“**{智能体}** 代 **{发送人}** 邀请你加入工作区 **{工作区}**”；附言前后加中文引号；字段“角色”“有效期至”（`1 月 2 日` 格式，服务器本地时区）；主按钮“加入工作区”，回传值 `{"action":"join_workspace","invite_id":"..."}`；次按钮“下载 Marvis”；底部“{n} 人已加入”（n=0 时不显示）。失效状态标题“邀请已失效”、灰色模板、主按钮禁用；已加入状态标题“已加入 {工作区}”、绿色模板、正文“打开 Marvis，用飞书登录即可使用。”。角色文案：`member`→“成员”，`admin`→“管理员”。

- [ ] **Step 1: 写失败的测试**
  - `TestBuildLarkInviteCard_Active`：解析 JSON，断言 `config.update_multi == true`、标题、按钮回传值含 `invite_id`、底部包含“3 人已加入”、`DownloadURL` 为空时没有下载按钮。
  - `TestBuildLarkInviteCard_AgentSender`：正文为“**设计助手** 代 **林晓** 邀请你加入工作区 **Dev**”。
  - `TestBuildLarkInviteCard_EscapesUserText`：附言为 ``**x** <at id=all></at> [a](http://e)``、工作区名带 `*`，断言这些文本出现在 `plain_text` 元素里，卡片 JSON 中不出现 `<at id=all>` 形式的 markdown 片段。
  - `TestBuildLarkInviteCard_InvalidAndJoined`：失效状态按钮 `disabled=true`、标题“邀请已失效”；已加入状态标题“已加入 Dev”且无“加入工作区”按钮。
- [ ] **Step 2: 运行确认失败**：`go test ./internal/handler -run TestBuildLarkInviteCard -count=1`。
- [ ] **Step 3: 实现** `lark_invite_card.go`。用户提供的文本（附言、人名、群名、工作区名）一律放 `plain_text` 元素；需要加粗的固定句式用 `markdown` 元素时，对插入值转义 `*`、`_`、`[`、`]`、`<`、`>`、`` ` ``。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** `feat(handler): Feishu invite card templates`

### Task 6: 发送、列表、详情、撤销等接口

**Files:**
- Create: `server/internal/handler/lark_invite.go`
- Modify: `server/internal/handler/handler.go`（Handler 新字段）
- Modify: `server/cmd/server/router.go`（路由）
- Test: `server/internal/handler/lark_invite_test.go`

**Interfaces:**
- Consumes: Task 1 `InviteAPIClient`、`ClassifyInviteError`；Task 3 查询；Task 5 `buildLarkInviteCard`。
- Produces:
  ```go
  // Handler 新字段
  LarkInviteAPI   lark.InviteAPIClient          // nil 表示飞书邀请不可用
  LarkInviteCreds lark.InstallationCredentials   // 飞书登录应用凭据
  LarkInviteDownloadURL string
  // 错误码常量
  larkInviteCodeNotConfigured = "lark_not_configured"
  larkInviteCodePermissionDenied = "permission_denied"
  larkInviteCodeInvalidTarget = "invalid_target"
  // 请求与响应
  type SendLarkInvitesRequest struct {
      ChatIDs []string `json:"chat_ids"`; UserOpenIDs []string `json:"user_open_ids"`; UserEmails []string `json:"user_emails"`
      Role string `json:"role"`; ExpiresInHours int `json:"expires_in_hours"`; MaxUses int `json:"max_uses"`
      Note string `json:"note"`; IdempotencyKey string `json:"idempotency_key"`
  }
  type LarkInviteTarget struct { Type, ID, IDType, Name string; AvatarURL *string }   // json: type,id,id_type,name,avatar_url
  type LarkInviteSendResult struct { ID *string; Target LarkInviteTarget; Role string; ExpiresAt *string; MaxUses *int; Status string; Error *LarkInviteError }
  type LarkInviteError struct { Code, Message string }
  type LarkInviteJoinedUser struct { UserID, Name, Email string; AvatarURL *string; JoinedAt string }
  type LarkInviteResponse struct { ID string; Target LarkInviteTarget; Role string; Status string; UseCount int; MaxUses *int; ExpiresAt string; RevokedAt *string; Note string; SentBy LarkInviteActor; SentByAgent *LarkInviteActor; CreatedAt string; Joined []LarkInviteJoinedUser }
  type LarkInviteActor struct { ID, Name string; AvatarURL *string }
  // 处理函数
  func (h *Handler) SendLarkInvites(w, r)      // POST   /api/workspaces/{id}/lark-invites        → 200 {results:[]LarkInviteSendResult}
  func (h *Handler) ListLarkInvites(w, r)      // GET    /api/workspaces/{id}/lark-invites?status= → 200 []LarkInviteResponse（Joined 最多 5 个）
  func (h *Handler) GetLarkInvite(w, r)        // GET    /api/workspaces/{id}/lark-invites/{inviteId} → 200 LarkInviteResponse（全部 Joined）
  func (h *Handler) RevokeLarkInvite(w, r)     // DELETE /api/workspaces/{id}/lark-invites/{inviteId} → 200 LarkInviteResponse
  func (h *Handler) ListLarkChats(w, r)        // GET    /api/workspaces/{id}/lark/chats → 200 []{chat_id,name,avatar_url,member_count}
  func (h *Handler) LookupLarkUser(w, r)       // GET    /api/workspaces/{id}/lark/users/lookup?email= → 200 {open_id,name,avatar_url,email} / 404 code user_not_found
  func (h *Handler) GetLarkInviteStatus(w, r)  // GET    /api/lark/status → 200 {enabled:bool}
  func (h *Handler) GetLarkInviteWelcome(w, r) // GET    /api/workspaces/{id}/lark-invites/welcome → 200 {invite_id,inviter_name,role} / 204
  func (h *Handler) AckLarkInviteWelcome(w, r) // POST   /api/workspaces/{id}/lark-invites/welcome/ack → 204
  func larkInviteStatus(inv db.LarkInvite, now time.Time) string // active|completed|expired|revoked
  ```
  状态常量：`larkInviteStatusActive="active"`、`Completed="completed"`、`Expired="expired"`、`Revoked="revoked"`、筛选 `all`。

- [ ] **Step 1: 写失败的测试**（DB 测试；`testHandler.LarkInviteAPI` 换成测试内的 `fakeInviteAPI`，记录调用、按 ID 返回预设结果或错误）
  - `TestSendLarkInvites_ChatAndUser`：一个群 + 一个 open_id，断言两条 `sent`、表里两行、`lark_message_id` 已写、个人卡片 `max_uses=1`、群卡片 `max_uses` 为空。
  - `TestSendLarkInvites_EmailResolvedToOpenID`：`user_emails` 先调 `LookupOpenIDByEmail`，卡片发给解析出的 open_id，`target_open_id` 已存。
  - `TestSendLarkInvites_PartialFailure`：fake 对 `oc_bad` 返回飞书码 230002，断言该项 `failed` + `bot_not_in_chat`、表里没有它的行，另一项成功。
  - `TestSendLarkInvites_Validation`：无接收方、`oc_` 以外的群 ID、`ou_` 以外的 open_id、`role=owner`、`expires_in_hours=0` 或 `721`、附言 201 字，均为 400 + `invalid_target` 或对应错误。
  - `TestSendLarkInvites_IdempotencyKey`：同 key 同目标发两次只发一次卡片，第二次返回第一次的 `id`。
  - `TestSendLarkInvites_NotConfigured`：`LarkInviteAPI=nil` 返回 403 + `lark_not_configured`；`h.SeatCapacity` 非 nil 时同样。
  - `TestSendLarkInvites_AgentRequiresAdminOriginator`：带 `X-Agent-ID`、`X-Task-ID` 的请求，任务 `originator_user_id` 为普通成员时 403 + `permission_denied`；为管理员时成功并记录 `sent_by_agent_id`；为空时 403。
  - `TestListLarkInvites_StatusFilter`：四种状态各一条，`status` 默认只回 active，`all` 回全部，按 `created_at` 倒序。
  - `TestRevokeLarkInvite_PatchesCardAndIgnoresPatchError`：fake 的 `PatchInviteCard` 返回错误，撤销仍 200、`revoked_at` 已写。
  - `TestLarkInviteWelcome_OnceAndAck`：有未确认的 join 时 GET 返回 200，ack 后 GET 返回 204。
- [ ] **Step 2: 运行确认失败**：`go test ./internal/handler -run 'TestSendLarkInvites|TestListLarkInvites|TestRevokeLarkInvite|TestLarkInviteWelcome' -count=1`。
- [ ] **Step 3: 实现** `lark_invite.go` 并在 `router.go` 的管理员路由组（`RequireWorkspaceRoleFromURL(queries, "id", "owner", "admin")`，紧挨 `/share-links`）注册发送、列表、详情、撤销、列群、查人；欢迎提示两条放成员级路由组；`/api/lark/status` 放在 `/api/me` 那组已登录路由里。智能体请求的第二道校验写成 `func (h *Handler) requireLarkInviteOriginator(w http.ResponseWriter, r *http.Request, workspaceID string) (agentID pgtype.UUID, ok bool)`，复用 `resolveActor` 和 `GetAgentTask`。多接收方发送用带上限的 goroutine 池。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** `feat(handler): send, list and revoke Feishu invite cards`

### Task 7: 卡片点击加入

**Files:**
- Create: `server/internal/handler/lark_invite_action.go`
- Test: `server/internal/handler/lark_invite_action_test.go`

**Interfaces:**
- Consumes: Task 4 `admitWorkspaceMember`；Task 5 卡片和回应构造；Task 3 `ClaimLarkInviteUse`、`CreateLarkInviteJoin`；现有 `findOrCreateUser`、`larkTenantAllowed`、`larkUserEmail`（入参改用 Task 1 的 `InviteUser` 时新增同规则的小函数 `larkInviteUserEmail(u lark.InviteUser) string`）、`ErrSignupProhibited` / `SignupError`。
- Produces:
  ```go
  // HandleLarkInviteCardAction 是长连接的 CardActionHandler，处理“加入工作区”点击，返回飞书回应 JSON。
  func (h *Handler) HandleLarkInviteCardAction(ctx context.Context, payload []byte) ([]byte, error)
  ```
  回调体字段：`event.operator.open_id`、`event.operator.tenant_key`、`event.action.value.action`、`event.action.value.invite_id`、`event.context.open_message_id`。
  提示文案常量：加入成功“已加入 {工作区}，打开 Marvis 用飞书登录即可”；已是成员“你已在 {工作区} 中”；失效“邀请已失效”；人数已满“邀请人数已满”；组织不符“此邀请仅限本组织成员”；个人卡片被别人点“此邀请仅限受邀人使用”；没有邮箱“飞书账号没有邮箱，无法加入”；禁止注册“当前服务器不允许注册新账号”；其他失败“加入失败，请稍后重试”。

- [ ] **Step 1: 写失败的测试**（DB 测试 + `fakeInviteAPI`，用 `buildLarkInviteCardAction(t, inviteID, openID, tenantKey)` 构造回调 JSON）
  - `TestLarkInviteAction_JoinsChatCard`：新邮箱点击后建账号（名字、头像来自飞书）、成为成员（角色取邀请的 role）、`use_count=1`、写入 `lark_invite_join`；回应 toast 为成功文案；之后异步调用了 `PatchInviteCard`，卡片底部“1 人已加入”。
  - `TestLarkInviteAction_UserCardReplacesCard`：个人卡片点击，回应里带 `card` 且标题“已加入 Dev”；别人的 open_id 点击回“此邀请仅限受邀人使用”。
  - `TestLarkInviteAction_DoubleClick`（Review Focus 1）：同一 open_id 并发点两次，最终一个成员、`use_count=1`，其中一次回“你已在 Dev 中”。
  - `TestLarkInviteAction_MissingInviteOrWorkspace`（Review Focus 2）：不存在的 `invite_id`、工作区已删除，均回“邀请已失效”，且未调用 `PatchInviteCard`。
  - `TestLarkInviteAction_SlowContactLookup`（Review Focus 3）：fake `GetUser` 阻塞到 ctx 结束；用 2.5 秒超时的 ctx 调用，断言在超时内返回“加入失败，请稍后重试”，没有新成员。
  - `TestLarkInviteAction_ExpiredRevokedFull`：过期、撤销回“邀请已失效”并调用 `PatchInviteCard` 改成失效卡片；达到上限回“邀请人数已满”。
  - `TestLarkInviteAction_TenantNotAllowed`：设置 `MARVIS_LARK_LOGIN_TENANT_KEYS=t_ok`，`tenant_key=t_other` 时回组织不符文案。
  - `TestLarkInviteAction_NoEmail` 和 `TestLarkInviteAction_SignupProhibited`。
  - `TestLarkInviteAction_SenderRemovedStillWorks`（Review Focus 5）：发送人被移出工作区后点击仍能加入，卡片上发送人名字照常。
- [ ] **Step 2: 运行确认失败**：`go test ./internal/handler -run TestLarkInviteAction -count=1`。
- [ ] **Step 3: 实现** `lark_invite_action.go`：解析回调 → 非 `join_workspace` 动作返回空回应 → `GetLarkInvite` → 状态检查 → 组织和受邀人检查 → `GetUser` 拿资料 → `findOrCreateUser` + 写名字头像 → `admitWorkspaceMember`（`Claim` 调 `ClaimLarkInviteUse`，`AfterCreate` 写 `lark_invite_join`，`Source="lark_invite"`）→ 构造回应。群卡片的人数更新在新 goroutine 里用 `context.WithoutCancel` 加 10 秒超时执行，失败只记日志。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** `feat(handler): join a workspace from a Feishu invite card`

### Task 8: 服务端接线和开关

**Files:**
- Modify: `server/cmd/server/router.go`（新增 `configureLarkInvite(h *handler.Handler)`）
- Modify: `server/cmd/server/main.go`（`sweepCtx` 下启动连接）
- Modify: `server/internal/handler/handler.go`（字段 `LarkInviteConn *lark.InviteConnection`）
- Modify: `.env.example`（新增两个变量的说明）
- Test: `server/cmd/server/lark_invite_config_test.go`

**Interfaces:**
- Consumes: Task 1 `NewInviteAPIClient`；Task 2 `NewWSLongConnConnector` 的 `CardHandler`、`NewInviteConnection`、`NewDropAllFrameDecoder`；Task 7 `HandleLarkInviteCardAction`；现有 `larkLoginCredentials`（如需在 `cmd/server` 使用，在 handler 包导出 `LarkLoginCredentials()` 包装）。
- Produces:
  ```go
  const larkInviteEnabledEnv = "MARVIS_LARK_INVITE_ENABLED"
  const desktopDownloadURLEnv = "MARVIS_DESKTOP_DOWNLOAD_URL"
  // larkInviteEnabled 读取开关：值为 "true"、"1"、"yes"（不区分大小写）时开启。
  func larkInviteEnabled() bool
  func configureLarkInvite(h *handler.Handler)
  ```
  开关开启、登录应用凭据齐全、`h.SeatCapacity == nil` 三者都满足时，设置 `h.LarkInviteAPI`、`h.LarkInviteCreds`（`Region: lark.RegionFeishu`）、`h.LarkInviteDownloadURL`、`h.LarkInviteConn`；否则全部保持零值，并在启动日志写明原因（英文）。HTTP 基址沿用 `MARVIS_LARK_HTTP_BASE_URL`，长连接基址沿用 `MARVIS_LARK_CALLBACK_BASE_URL`，代理沿用 `MARVIS_LARK_WS_PROXY_URL`。

- [ ] **Step 1: 写失败的测试** `TestLarkInviteEnabled`（表驱动：未设置、`false`、`TRUE`、`1`、`yes`）和 `TestConfigureLarkInvite`（开关关、缺凭据、席位容量开启三种情况 `h.LarkInviteAPI == nil`；全满足时非 nil）。
- [ ] **Step 2: 运行确认失败**：`go test ./cmd/server -run 'TestLarkInviteEnabled|TestConfigureLarkInvite' -count=1`。
- [ ] **Step 3: 实现**，`main.go` 在 `h.LarkTyping` 旁加 `if h.LarkInviteConn != nil { go h.LarkInviteConn.Run(sweepCtx) }`。
- [ ] **Step 4: 运行确认通过**，并 `go build ./...`。
- [ ] **Step 5: 提交** `feat(server): wire Feishu invite cards behind MARVIS_LARK_INVITE_ENABLED`

### Task 9: 飞书登录同步头像

**Files:**
- Modify: `server/internal/handler/auth.go`（`issueOAuthLogin`）
- Test: `server/internal/handler/auth_lark_test.go`

**Interfaces:**
- Produces: `func (h *Handler) shouldReplaceAvatarFromProvider(current pgtype.Text) bool` —— 当前为空，或是 `http(s)://` 开头、不以 `emoji:` 开头、且 `h.Storage == nil || h.ownedStorageKey(current) == ""` 时返回 true。只在 `authMethod == authMethodLark` 时用它；Google 登录保持“头像为空才写”。

- [ ] **Step 1: 写失败的测试** `TestLarkLogin_AvatarSync`（表驱动四种当前值：空 → 换成飞书头像；`https://s1-imfile.feishucdn.com/old` → 换；本服务存储的上传 URL → 不变；`emoji:🦊` → 不变）和 `TestGoogleLogin_AvatarOnlyWhenEmpty`。
- [ ] **Step 2: 运行确认失败**：`go test ./internal/handler -run 'TestLarkLogin_AvatarSync|TestGoogleLogin_AvatarOnlyWhenEmpty' -count=1`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** `feat(auth): refresh the Feishu avatar on every Feishu sign-in`

### Task 10: CLI `marvis workspace lark-invite`

**Files:**
- Create: `server/cmd/marvis/cmd_lark_invite.go`
- Modify: `server/cmd/marvis/cmd_workspace.go`（把 `larkInviteCmd` 挂到 `workspaceCmd`）
- Test: `server/cmd/marvis/cmd_lark_invite_test.go`

**Interfaces:**
- Consumes: Task 6 的接口和 JSON 字段。
- Produces: 子命令 `send`、`list`、`get`、`revoke`。
  - `send [workspace-id|slug|prefix]`：`--chat-id string`、`--user-id string`（二选一，必填其一，帮助文本照抄：`(required, mutually exclusive with --user-id) chat ID (oc_xxx)`、`(required, mutually exclusive with --chat-id) user open_id (ou_xxx)`）、`--role string`（默认 `member`）、`--expires-in duration`（默认 `168h`，范围 1h–720h，接受 `7d` 这种写法）、`--max-uses int`、`--note string`、`--idempotency-key string`（最多 50 字符）、`--output string`（默认 `table`）。`Long` 里写明 ID 与 `lark-cli im +messages-send` 一致、open_id 必须来自 `MARVIS_LARK_LOGIN_APP_ID` 同一个应用。
  - `list [workspace]`：`--status active|completed|expired|revoked|all`（默认 `active`）、`--output`。
  - `get <invite-id>`、`revoke <invite-id>...`：`--output`。
  - 表格列：send `ID TYPE ROLE EXPIRES STATUS TARGET`；list `ID TYPE ROLE JOINED EXPIRES STATUS TARGET`。ID 显示前 8 位，TARGET 放最后一列。
  - 发送结果为 `failed` 时打印 `Error: <code>: <message>` 并返回非零退出码。

- [ ] **Step 1: 写失败的测试**（`httptest.NewServer` + `MARVIS_SERVER_URL`，沿用 `cmd_workspace_test.go` 的写法）
  - `TestLarkInviteSend_ChatID`：断言请求体 `{"chat_ids":["oc_1"],"role":"member","expires_in_hours":168,...}`，表格输出最后一列为群名。
  - `TestLarkInviteSend_RequiresExactlyOneTarget`：都不传、都传，返回错误且不发请求。
  - `TestLarkInviteSend_RejectsBadPrefixes`：`--chat-id ou_x`、`--user-id oc_x` 报错。
  - `TestLarkInviteSend_FailedResultExitsNonZero`：服务端返回 `failed` + `bot_not_in_chat`，命令返回错误，消息包含 `bot_not_in_chat`。
  - `TestLarkInviteSend_ExpiresInDays`：`--expires-in 3d` 发出 `expires_in_hours=72`。
  - `TestLarkInviteList_StatusFlag` 和 `TestLarkInviteRevoke_MultipleIDs`。
- [ ] **Step 2: 运行确认失败**：`go test ./cmd/marvis -run TestLarkInvite -count=1`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过**，`go run ./cmd/marvis workspace lark-invite send --help` 输出与画布 34 号画板一致。
- [ ] **Step 5: 提交** `feat(cli): marvis workspace lark-invite`

### Task 11: 实测（需要用户参与）

此任务由主控和用户一起完成，不派给实现者。

- [ ] **Step 1: 用户在飞书开放平台配置登录应用**：开启机器人；添加权限 `im:message:send_as_bot`、`im:chat:readonly`、`contact:user.id:readonly`、`contact:user.base:readonly`、`contact:user.email:readonly`；事件与回调选长连接，在“回调配置”里添加 `card.action.trigger`；可用范围覆盖测试同事；发布新版本。
- [ ] **Step 2: 本机启动**：worktree 的 `.env.worktree` 里设 `MARVIS_LARK_INVITE_ENABLED=true`，`make start-worktree`，确认启动日志出现长连接建立；正式服务器上的开关保持关闭。
- [ ] **Step 3: 逐项验证并记录**：把 Marvis 机器人拉进一个测试群；`marvis workspace lark-invite send --chat-id <oc>`，另一账号点“加入工作区”，确认提示、成员写入、群卡片人数更新；`--user-id <ou>` 发私聊卡片，点击后卡片变“已加入”；撤销后卡片变失效；对机器人不在的群、可用范围外的人，记录飞书实际返回的错误码。
- [ ] **Step 4: 修正**：实际回应帧格式、错误码与 Task 1、Task 2 的假设不一致时，改常量和测试，单独提交 `fix(lark): align invite card handling with live Feishu behavior`。

### Task 12: 前端数据层

**Files:**
- Modify: `packages/core/types/workspace.ts`
- Modify: `packages/core/api/schemas.ts`、`packages/core/api/schemas.test.ts`
- Modify: `packages/core/api/client.ts`
- Modify: `packages/core/workspace/queries.ts`

**Interfaces:**
- Consumes: Task 6 的 JSON。
- Produces:
  ```ts
  export type LarkInviteStatus = "active" | "completed" | "expired" | "revoked";
  export interface LarkInviteTarget { type: "chat" | "user"; id: string; id_type: string; name: string; avatar_url: string | null }
  export interface LarkInviteActor { id: string; name: string; avatar_url: string | null }
  export interface LarkInviteJoinedUser { user_id: string; name: string; email: string; avatar_url: string | null; joined_at: string }
  export interface LarkInvite { id: string; target: LarkInviteTarget; role: MemberRole; status: LarkInviteStatus; use_count: number; max_uses: number | null; expires_at: string; revoked_at: string | null; note: string; sent_by: LarkInviteActor; sent_by_agent: LarkInviteActor | null; created_at: string; joined: LarkInviteJoinedUser[] }
  export interface LarkInviteSendResult { id: string | null; target: LarkInviteTarget; role: MemberRole; expires_at: string | null; max_uses: number | null; status: "sent" | "failed"; error: { code: string; message: string } | null }
  export interface LarkChat { chat_id: string; name: string; avatar_url: string | null; member_count: number }
  export interface LarkUserLookup { open_id: string; name: string; avatar_url: string | null; email: string }
  // ApiClient 方法
  getLarkInviteStatus(): Promise<{ enabled: boolean }>
  listLarkInvites(workspaceId: string, status?: LarkInviteStatus | "all"): Promise<LarkInvite[]>
  sendLarkInvites(workspaceId: string, data: { chat_ids?: string[]; user_emails?: string[]; role: MemberRole; expires_in_hours: number; max_uses?: number; note?: string }): Promise<LarkInviteSendResult[]>
  revokeLarkInvite(workspaceId: string, inviteId: string): Promise<LarkInvite>
  listLarkChats(workspaceId: string): Promise<LarkChat[]>
  lookupLarkUser(workspaceId: string, email: string): Promise<LarkUserLookup>
  getLarkInviteWelcome(workspaceId: string): Promise<{ invite_id: string; inviter_name: string; role: MemberRole } | null>
  ackLarkInviteWelcome(workspaceId: string): Promise<void>
  // queries.ts
  workspaceKeys.larkInvites(wsId), workspaceKeys.larkChats(wsId), larkStatusKey
  larkInviteStatusOptions(), larkInviteListOptions(wsId, enabled), larkChatListOptions(wsId, enabled)
  ```
  未知 `status` 回落为 `"expired"`，未知 `target.type` 回落为 `"chat"`。

- [ ] **Step 1: 写失败的测试**（`schemas.test.ts`）：`LarkInviteSchema` 缺字段时用默认值、未知状态回落；`LarkInviteSendResultListSchema` 解析 `{results:[...]}`；畸形响应（非数组、`null`）回落为空数组。
- [ ] **Step 2: 运行确认失败**：`pnpm --filter @marvis/core exec vitest run api/schemas.test.ts`。
- [ ] **Step 3: 实现** schema、类型、client 方法（全部走 `parseWithFallback`，带 `endpoint` 标签）、查询选项。
- [ ] **Step 4: 运行确认通过**，再跑 `pnpm --filter @marvis/core typecheck`。
- [ ] **Step 5: 提交** `feat(core): Feishu invite API client and queries`

### Task 13: 成员页的飞书邀请视图和发送弹窗

**Files:**
- Create: `packages/views/settings/components/lark-invites-view.tsx`、`lark-invites-view.test.tsx`
- Create: `packages/views/settings/components/lark-invite-send-dialog.tsx`、`lark-invite-send-dialog.test.tsx`
- Modify: `packages/views/settings/components/members-tab.tsx`
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko,fr}/settings.json`

**Interfaces:**
- Consumes: Task 12 的 API 和查询；现有 `ActorAvatar`（成员圆形、智能体方形）、`SettingsCard`、`SettingsViewTabs`、`Dialog`、`Button`。
- Produces:
  ```tsx
  export function LarkInvitesView(props: { wsId: string }): JSX.Element
  export function LarkInviteSendDialog(props: { wsId: string; open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element
  ```
  `members-tab.tsx`：`MembersView` 增加 `"lark"`；`canManageWorkspace && larkStatus.enabled` 时显示“飞书邀请”标签（不受 `canShareJoinLinks` 限制）；该视图右上角按钮“发送飞书邀请”打开弹窗。
  文案键放在 `members.lark.*` 下，中文：`tab`“飞书邀请”、`send`“发送飞书邀请”、`intro`“卡片发到飞书群或个人，点击“加入工作区”的人直接成为成员。”、列名“接收方 / 角色 / 已加入 / 有效期 / 发送人”、状态“有效 / 已完成 / 已过期 / 已撤销”、`joined_count`“{{count}} 人已加入”、`joined_of`“{{count}} / {{max}}”、`not_joined`“未加入”、`joined`“已加入”、`chat_sub`“群聊 · {{count}} 人”、`user_sub`“个人 · {{email}}”、`revoke`“撤销”、`empty`“还没有发出飞书邀请”、`not_configured_title`“服务器未配置飞书机器人”、`not_configured_body`“配置后可以把邀请卡片发到飞书群或个人。需要服务器管理员在飞书登录应用里开启机器人能力。”；弹窗：`dialog_title`“发送飞书邀请”、`tab_chat`“群聊”、`tab_user`“个人”、`search_chat`“搜索群名”、`chat_hint`“这里列出 Marvis 机器人所在的群。要发到其他群，先在飞书群设置里添加 Marvis 机器人。”、`email_label`“邮箱”、`email_placeholder`“输入邮箱，回车添加”、`email_not_found`“飞书里没有 {{email}}，发送时会跳过。”、`user_hint`“对方会在和 Marvis 机器人的私聊里收到卡片。”、`role_label`“加入后的角色”、`expiry_label`“有效期”、`max_uses_label`“人数上限”、`max_uses_placeholder`“不限”、`note_label`“附言”、`note_placeholder`“显示在卡片上”、`sender_hint`“以 Marvis 机器人的名义发送”、`send_to_chats`“发送到 {{count}} 个群”、`send_to_users`“发送给 {{count}} 人”、`preview`“卡片预览”、`sent_toast`“已发送 {{count}} 张卡片”、错误码文案 `errors.<code>` 七条（见设计文档第 9 节错误码表，中文按 Task 7 的提示风格）。

- [ ] **Step 1: 写失败的测试**（mock `@marvis/core/api`）
  - `LarkInvitesView`：列表渲染四种状态，有效行有“撤销”按钮、其他没有；点撤销调用 `revokeLarkInvite` 并刷新；空状态；`getLarkInviteStatus` 返回 `enabled:false` 时显示未配置提示。
  - `LarkInviteSendDialog`：群聊标签勾选两个群后按钮文案“发送到 2 个群”，提交参数 `chat_ids` 正确；个人标签回车添加邮箱调用 `lookupLarkUser`，404 的邮箱标红且不进提交参数；部分失败时逐条显示错误文案；人数上限只在群聊标签出现。
  - `members-tab`：管理员且启用时出现“飞书邀请”标签，普通成员看不到。
- [ ] **Step 2: 运行确认失败**：`pnpm --filter @marvis/views exec vitest run settings/components/lark-invite`。
- [ ] **Step 3: 实现**，样式对照画布 30、31 号画板：群有 `avatar_url` 时显示图片，没有时按小队样式（白底细描边、圆角方形、群名首字）；个人和发送人用 `ActorAvatar`，有图显示图片，智能体方形。五种语言文案补齐。
- [ ] **Step 4: 运行确认通过**，再跑 `pnpm --filter @marvis/views exec vitest run locales/parity.test.ts` 和 `pnpm --filter @marvis/views typecheck`。
- [ ] **Step 5: 提交** `feat(views): Feishu invites in workspace members settings`

### Task 14: 首次进入提示

**Files:**
- Create: `packages/views/layout/lark-invite-welcome.tsx`、`lark-invite-welcome.test.tsx`
- Modify: `packages/views/layout/dashboard-layout.tsx`
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko,fr}/settings.json`（或 layout 所用命名空间）

**Interfaces:**
- Consumes: Task 12 `getLarkInviteWelcome`、`ackLarkInviteWelcome`。
- Produces: `export function LarkInviteWelcome(props: { wsId: string; workspaceName: string }): null`，在 `DashboardLayout` 拿到当前工作区后挂载；查到待提示记录时弹一次 toast（标题“已加入 {{workspace}}”，正文“通过{{inviter}}的飞书邀请，角色为{{role}}。”），随后调用 ack。

- [ ] **Step 1: 写失败的测试**：有记录时弹出 toast 并调用 ack 一次；返回 null 时不弹；同一 wsId 重渲染不重复弹。
- [ ] **Step 2: 运行确认失败**：`pnpm --filter @marvis/views exec vitest run layout/lark-invite-welcome.test.tsx`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过**，`pnpm typecheck`。
- [ ] **Step 5: 提交** `feat(views): welcome toast after joining from a Feishu invite`

### Task 15: 全量验证

- [ ] **Step 1:** `make test`（Go 全量，含 race）通过。
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` 通过。
- [ ] **Step 3:** 改动的 Go 文件 `gofmt -l`、`goimports -local github.com/yunboom/marvis/server -l` 无输出，`go vet ./...` 通过。
- [ ] **Step 4:** `git diff --check feat/marvis-redesign...HEAD` 无输出。
