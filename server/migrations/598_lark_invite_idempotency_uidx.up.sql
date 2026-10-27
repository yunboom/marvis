-- 同一工作区、同一接收方、同一幂等键只能有一张邀请卡片；没有幂等键的邀请不受限。
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_lark_invite_idempotency
    ON lark_invite (workspace_id, target_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
