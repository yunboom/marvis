-- 同一个用户通过同一张邀请只记录一次加入。
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_lark_invite_join_invite_user
    ON lark_invite_join (invite_id, user_id);
