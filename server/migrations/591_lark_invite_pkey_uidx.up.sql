-- lark_invite 主键的底层唯一索引，592 用 PRIMARY KEY USING INDEX 挂为主键。
-- 单独一个迁移文件，保证 CONCURRENTLY 在事务之外执行（仓库约定）。
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS lark_invite_pkey_uidx
    ON lark_invite (id);
