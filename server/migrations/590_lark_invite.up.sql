-- 飞书邀请卡片：lark_invite 记录一张发给群或个人的邀请卡片，lark_invite_join 记录通过卡片加入工作区的人。
--
-- 仓库约定：不加外键，关联关系由应用层校验；两张表都不在建表时声明主键或索引。
-- lark_invite 的主键走 591（并发建唯一索引）+ 592（USING INDEX 挂为主键），
-- 其余索引分别在 593-596 里并发创建，每个文件只有一条语句。
--
-- target_type：chat（群，一张卡片多人可点）/ user（个人，仅受邀人可点）。
-- target_id_type：chat_id / open_id / email，target_id 按它解释。
-- target_open_id：邮箱或手机号解析出的 open_id，个人卡片用它校验点击人。
-- sent_by_user_id 是发起人；智能体代发时 sent_by_agent_id 记录智能体。
CREATE TABLE lark_invite (
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    target_type       TEXT NOT NULL CHECK (target_type IN ('chat', 'user')),
    target_id         TEXT NOT NULL,
    target_id_type    TEXT NOT NULL CHECK (target_id_type IN ('chat_id', 'open_id', 'email')),
    target_open_id    TEXT,
    target_name       TEXT NOT NULL DEFAULT '',
    target_avatar_url TEXT,
    role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    max_uses          INT,
    use_count         INT NOT NULL DEFAULT 0,
    expires_at        TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    note              TEXT NOT NULL DEFAULT '',
    idempotency_key   TEXT,
    lark_message_id   TEXT,
    sent_by_user_id   UUID NOT NULL,
    sent_by_agent_id  UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 通过邀请卡片加入工作区的记录。welcomed_at 为空表示首次进入提示还没有展示过。
CREATE TABLE lark_invite_join (
    invite_id    UUID NOT NULL,
    workspace_id UUID NOT NULL,
    user_id      UUID NOT NULL,
    lark_open_id TEXT NOT NULL,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    welcomed_at  TIMESTAMPTZ
);
