-- Knowledge base jobs: a chat conversation plus the draft its agent links in
-- kb_job_draft, and the merge requests made from that draft.

-- name: CreateKbJob :one
INSERT INTO kb_job (
    workspace_id, knowledge_base_id, name, starter, agent_id, chat_session_id,
    annotation_ids, page_id, created_by
) VALUES (
    sqlc.arg('workspace_id'), sqlc.arg('knowledge_base_id'), sqlc.arg('name'), sqlc.arg('starter'),
    sqlc.arg('agent_id'), sqlc.arg('chat_session_id'), sqlc.arg('annotation_ids')::uuid[],
    sqlc.narg('page_id'), sqlc.arg('created_by')
)
RETURNING *;

-- name: DeleteKbJob :exec
DELETE FROM kb_job WHERE workspace_id = $1 AND id = $2;

-- name: GetKbJobInWorkspace :one
SELECT * FROM kb_job
WHERE workspace_id = $1 AND id = $2;

-- name: GetKbJobByDraft :one
-- The job a draft is linked to.
SELECT j.* FROM kb_job_draft jd
JOIN kb_job j ON j.id = jd.job_id
WHERE jd.draft_id = $1;

-- name: ListKbJobStates :many
-- The parts of each job's state that are not stored on kb_job: the linked
-- draft, the chat's latest task and whether a turn is in flight, the last
-- reply and the draft's latest merge request. Detail and list share it;
-- job_ids narrows it to the given jobs.
SELECT
    j.id,
    COALESCE(a.name, '')::text AS agent_name,
    jd.draft_id,
    COALESCE(d.version, 0)::bigint AS draft_version,
    COALESCE(d.status, '')::text AS draft_status,
    d.updated_at AS draft_updated_at,
    (SELECT count(*) FROM kb_draft_page dp WHERE dp.draft_id = jd.draft_id)::bigint AS draft_pages,
    COALESCE(lt.status, '')::text AS last_task_status,
    EXISTS (
        SELECT 1 FROM agent_task_queue atq
        WHERE atq.chat_session_id = j.chat_session_id
          AND atq.status = ANY(sqlc.arg('running_statuses')::text[])
    )::bool AS running,
    COALESCE(lm.content, '')::text AS last_reply,
    lm.created_at AS last_reply_at,
    mr.id AS mr_id,
    COALESCE(mr.number, 0)::int AS mr_number,
    COALESCE(mr.title, '')::text AS mr_title,
    COALESCE(mr.status, '')::text AS mr_status,
    COALESCE(mr.author_type, '')::text AS mr_author_type,
    mr.author_id AS mr_author_id,
    mr.merged_by AS mr_merged_by,
    mr.closed_by AS mr_closed_by,
    COALESCE(mr.close_reason, '')::text AS mr_close_reason
FROM kb_job j
LEFT JOIN agent a ON a.id = j.agent_id
LEFT JOIN kb_job_draft jd ON jd.job_id = j.id
LEFT JOIN kb_draft d ON d.id = jd.draft_id
LEFT JOIN LATERAL (
    SELECT atq.status FROM agent_task_queue atq
    WHERE atq.chat_session_id = j.chat_session_id
    ORDER BY atq.created_at DESC
    LIMIT 1
) lt ON true
LEFT JOIN LATERAL (
    SELECT m.content, m.created_at FROM chat_message m
    WHERE m.chat_session_id = j.chat_session_id
      AND m.role = 'assistant'
    ORDER BY m.created_at DESC
    LIMIT 1
) lm ON true
LEFT JOIN LATERAL (
    SELECT * FROM kb_merge_request r
    WHERE r.draft_id = jd.draft_id
    ORDER BY r.created_at DESC
    LIMIT 1
) mr ON true
WHERE j.workspace_id = sqlc.arg('workspace_id')
  AND j.id = ANY(sqlc.arg('job_ids')::uuid[]);

-- name: ListKbJobsByCreator :many
-- A member's jobs of one knowledge base, newest first.
SELECT * FROM kb_job
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND created_by = sqlc.arg('created_by')
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('row_limit');

-- name: SetKbDraftStatus :one
UPDATE kb_draft SET status = sqlc.arg('status'), updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: NextKbMergeRequestNumber :one
-- Allocates the workspace's next merge request number; the row lock on
-- kb_workspace serialises concurrent allocations.
INSERT INTO kb_workspace (workspace_id, next_mr_number)
VALUES (sqlc.arg('workspace_id'), 2)
ON CONFLICT (workspace_id) DO UPDATE
    SET next_mr_number = kb_workspace.next_mr_number + 1, updated_at = now()
RETURNING (next_mr_number - 1)::int AS number;

-- name: CreateKbMergeRequest :one
INSERT INTO kb_merge_request (
    workspace_id, number, knowledge_base_id, title, summary, source, risk,
    author_type, author_id, draft_id, job_id, annotation_ids, reverts_id
) VALUES (
    sqlc.arg('workspace_id'), sqlc.arg('number'), sqlc.arg('knowledge_base_id'), sqlc.arg('title'),
    sqlc.arg('summary'), sqlc.arg('source'), sqlc.arg('risk'), sqlc.arg('author_type'),
    sqlc.arg('author_id'), sqlc.arg('draft_id'), sqlc.narg('job_id'), sqlc.arg('annotation_ids')::uuid[],
    sqlc.narg('reverts_id')
)
RETURNING *;

-- name: GetOpenKbMergeRequestByDraft :one
SELECT * FROM kb_merge_request
WHERE draft_id = sqlc.arg('draft_id') AND status = ANY(sqlc.arg('statuses')::text[]);

-- name: ListKbAnnotationsByIDs :many
-- Annotations brought into a job; ids outside the knowledge base are left
-- out, so the caller can tell.
SELECT * FROM kb_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);
