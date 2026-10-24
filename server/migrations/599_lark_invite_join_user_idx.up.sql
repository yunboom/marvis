-- 按用户和工作区查询未展示的首次进入提示。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lark_invite_join_user_workspace
    ON lark_invite_join (user_id, workspace_id);
