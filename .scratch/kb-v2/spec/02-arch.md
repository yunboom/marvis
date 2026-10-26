# 2 总体架构

```
flowchart LR
  subgraph Client[客户端]
    WEB[Web / Desktop<br/>packages/views/kb]
    CLI[marvis kb CLI]
  end
  subgraph Server[Marvis Server]
    API[KB API<br/>/api/kb/*]
    SVC[KB 服务<br/>页面 / 草稿 / 合并 / 检查 / 检索 / 导出]
    CHAT[聊天服务<br/>现有]
    BLD[构建器智能体<br/>现有模式]
    WS[WebSocket Hub<br/>现有]
  end
  subgraph Store[存储]
    PG[(Postgres<br/>kb_* 表)]
    S3[(对象存储<br/>原始资料，现有)]
  end
  subgraph Runtime[运行时]
    D[Daemon]
    AG[执行智能体<br/>任务令牌]
  end
  AUTO[自动化<br/>现有，用户自建]

  WEB -->|REST| API
  WEB -->|订阅事件| WS
  CLI -->|REST| API
  API --> SVC
  SVC --> PG
  SVC --> S3
  SVC -->|事件| WS
  API -->|建会话 / 发首条消息| CHAT
  API -->|建隐藏构建器| BLD
  CHAT -->|派任务| D
  AUTO -->|派任务| D
  D --> AG
  AG -->|marvis kb| CLI
```

图 1 · 组件与调用关系。聊天、构建器、自动化、Daemon、WebSocket、对象存储都是现有能力。
| 组件 | 职责 | 新增 / 复用 | 
| KB API | 知识库、页面、草稿、批注、作业、变更请求、检索、导出的 REST 接口 | 新增 `server/internal/handler/kb_*.go` | 
| KB 服务 | 块模型、草稿写入、三方合并、格式检查、链接表、检索、OKF 导出 | 新增 `server/internal/kb/` | 
| 聊天服务 | 「知识库作业」的对话就是一个聊天会话；消息、执行过程、停止、排队全部沿用 | 复用 | 
| 构建器智能体 | 创建 / 配置知识库的隐藏智能体 | 复用创建智能体的模式（`9a7f600b6` `server/internal/handler/agent_builder.go:19` 指令常量、`:57` 建会话、`:124` 写入指令） | 
| 任务令牌 | 智能体调用 CLI 的凭证，按令牌绑定的人判权限；记下发起变更请求的任务 | 复用（`server/internal/handler/daemon.go:4278-4330`） | 
| 运行时说明 | 执行任务 / 聊天 / 自动化时注入「Knowledge Bases」一节 | 在现有拼装函数里加一节（`9a7f600b6` `server/internal/daemon/execenv/runtime_config_sections.go:923`） | 
| 对象存储 | 原始资料文件 | 复用（`server/cmd/server/router.go:459`） | 
| 自动化 | 定时收录 / 健康检查由用户在对话里让智能体建普通自动化 | 复用，零改动 |
