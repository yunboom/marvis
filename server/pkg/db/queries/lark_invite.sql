-- name: CreateLarkInvite :one
-- id 为 NULL 时由数据库生成；带幂等键的邀请由调用方从幂等键派生固定 id，重试时卡片里的 invite_id 不变。
INSERT INTO lark_invite (
    id, workspace_id, target_type, target_id, target_id_type, target_open_id,
    target_name, target_avatar_url, role, max_uses, expires_at, note,
    idempotency_key, sent_by_user_id, sent_by_agent_id
)
VALUES (
    COALESCE(sqlc.narg(id)::uuid, gen_random_uuid()),
    sqlc.arg(workspace_id), sqlc.arg(target_type), sqlc.arg(target_id), sqlc.arg(target_id_type), sqlc.narg(target_open_id),
    sqlc.arg(target_name), sqlc.narg(target_avatar_url), sqlc.arg(role), sqlc.narg(max_uses), sqlc.arg(expires_at), sqlc.arg(note),
    sqlc.narg(idempotency_key), sqlc.arg(sent_by_user_id), sqlc.narg(sent_by_agent_id)
)
RETURNING *;

-- name: GetLarkInviteInWorkspace :one
SELECT * FROM lark_invite
WHERE id = $1 AND workspace_id = $2;

-- name: GetLarkInvite :one
-- 卡片点击回调里只有 invite_id，没有工作区上下文，所以只按 id 查。
SELECT * FROM lark_invite
WHERE id = $1;

-- name: GetLarkInviteByIdempotencyKey :one
SELECT * FROM lark_invite
WHERE workspace_id = $1
  AND target_id = $2
  AND idempotency_key = $3;

-- name: SetLarkInviteMessageID :exec
UPDATE lark_invite
SET lark_message_id = $2
WHERE id = $1;

-- name: DeleteLarkInvite :exec
DELETE FROM lark_invite
WHERE id = $1;

-- name: ListLarkInvitesByWorkspace :many
SELECT * FROM lark_invite
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT 200;

-- name: RevokeLarkInvite :one
-- 只撤销尚未撤销的邀请，已撤销的不改写首次撤销时间，也不返回行。
UPDATE lark_invite
SET revoked_at = now()
WHERE id = $1
  AND workspace_id = $2
  AND revoked_at IS NULL
RETURNING *;

-- name: ClaimLarkInviteUse :one
-- 点击加入时原子占用一次名额。条件更新同时复核撤销、过期和人数上限，
-- 并发点击不会越过上限；没有行返回表示邀请已不可用。
UPDATE lark_invite
SET use_count = use_count + 1
WHERE id = $1
  AND revoked_at IS NULL
  AND expires_at > now()
  AND (max_uses IS NULL OR use_count < max_uses)
RETURNING *;

-- name: CreateLarkInviteJoin :exec
INSERT INTO lark_invite_join (invite_id, workspace_id, user_id, lark_open_id)
VALUES ($1, $2, $3, $4);

-- name: ListLarkInviteJoinsByInviteIDs :many
SELECT j.*,
       u.name       AS user_name,
       u.email      AS user_email,
       u.avatar_url AS user_avatar_url
FROM lark_invite_join j
JOIN "user" u ON u.id = j.user_id
WHERE j.invite_id = ANY(sqlc.arg(invite_ids)::uuid[])
ORDER BY j.joined_at DESC;

-- name: GetPendingLarkInviteWelcome :one
-- 同一用户在同一工作区有多条未展示的记录时，取最早的一条，即真正把他带进工作区的那张邀请。
SELECT j.invite_id,
       i.role,
       u.name AS inviter_name
FROM lark_invite_join j
JOIN lark_invite i ON i.id = j.invite_id
JOIN "user" u ON u.id = i.sent_by_user_id
WHERE j.user_id = $1
  AND j.workspace_id = $2
  AND j.welcomed_at IS NULL
ORDER BY j.joined_at ASC
LIMIT 1;

-- name: MarkLarkInviteWelcomed :exec
UPDATE lark_invite_join
SET welcomed_at = now()
WHERE user_id = $1
  AND workspace_id = $2
  AND welcomed_at IS NULL;
