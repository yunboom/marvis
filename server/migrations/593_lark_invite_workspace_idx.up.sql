-- 按工作区列出邀请，最新的在前。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lark_invite_workspace
    ON lark_invite (workspace_id, created_at DESC);
