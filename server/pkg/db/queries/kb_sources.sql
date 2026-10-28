-- name: ListKbSources :many
-- Material a knowledge base can ingest (spec 7.13 GET /api/kb/sources):
-- issues, issue comments, chats and the knowledge base's raw source files,
-- newest first. A source is ingested once a claim of this knowledge base
-- cites its uri (a raw file also by uri#page=N). chat_creator limits chats
-- to the ones a member started; NULL reads every member's public chat.
WITH src AS (
    SELECT 'task'::text AS kind,
           ('task://' || w.issue_prefix || '-' || i.number)::text AS uri,
           i.title::text AS title,
           (w.issue_prefix || '-' || i.number)::text AS ref,
           i.updated_at AS updated_at
      FROM issue i
      JOIN workspace w ON w.id = i.workspace_id
     WHERE sqlc.arg('want_task')::bool
       AND i.workspace_id = sqlc.arg('workspace_id')::uuid
       AND (sqlc.narg('since')::timestamptz IS NULL OR i.updated_at > sqlc.narg('since')::timestamptz)
    UNION ALL
    SELECT 'comment'::text,
           ('task://' || w.issue_prefix || '-' || i.number || '#comment-' || c.id)::text,
           i.title::text,
           (w.issue_prefix || '-' || i.number)::text,
           c.updated_at
      FROM comment c
      JOIN issue i ON i.id = c.issue_id
      JOIN workspace w ON w.id = i.workspace_id
     WHERE sqlc.arg('want_comment')::bool
       AND c.workspace_id = sqlc.arg('workspace_id')::uuid
       AND c.deleted_at IS NULL
       AND c.type = 'comment'
       AND (sqlc.narg('since')::timestamptz IS NULL OR c.updated_at > sqlc.narg('since')::timestamptz)
    UNION ALL
    SELECT 'chat'::text,
           ('chat://' || cs.id)::text,
           'chat'::text,
           cs.id::text,
           lm.at
      FROM chat_session cs
      JOIN agent a ON a.id = cs.agent_id AND a.kind <> 'system'
      JOIN LATERAL (
          SELECT max(m.created_at) AS at
            FROM chat_message m
           WHERE m.chat_session_id = cs.id
             AND m.message_kind != 'channel_command'
      ) lm ON lm.at IS NOT NULL
     WHERE sqlc.arg('want_chat')::bool
       AND cs.workspace_id = sqlc.arg('workspace_id')::uuid
       AND cs.status = 'active'
       AND (sqlc.narg('chat_creator')::uuid IS NULL OR cs.creator_id = sqlc.narg('chat_creator')::uuid)
       -- Ordinary chats and run follow-up chats; never a job's own chat or a
       -- builder conversation.
       AND cs.source = ANY(sqlc.arg('chat_sources')::text[])
       AND (sqlc.narg('since')::timestamptz IS NULL OR lm.at > sqlc.narg('since')::timestamptz)
    UNION ALL
    SELECT 'raw'::text,
           ('raw://sources/' || r.name)::text,
           r.name::text,
           r.name::text,
           r.created_at
      FROM kb_raw r
     WHERE sqlc.arg('want_raw')::bool
       AND r.knowledge_base_id = sqlc.arg('knowledge_base_id')::uuid
       AND r.kind = 'source'
       AND (sqlc.narg('since')::timestamptz IS NULL OR r.created_at > sqlc.narg('since')::timestamptz)
), marked AS (
    SELECT s.*,
           EXISTS (
               SELECT 1 FROM kb_claim cl
                WHERE cl.knowledge_base_id = sqlc.arg('knowledge_base_id')::uuid
                  AND (cl.evidence @> jsonb_build_array(jsonb_build_object('uri', s.uri))
                       OR (s.kind = 'raw' AND EXISTS (
                           SELECT 1 FROM jsonb_array_elements(cl.evidence) e
                            WHERE starts_with(e->>'uri', s.uri || '#')
                       )))
           ) AS ingested
      FROM src s
)
SELECT kind, uri, title, ref, updated_at, ingested
  FROM marked
 WHERE sqlc.arg('include_ingested')::bool OR NOT ingested
 ORDER BY updated_at DESC, uri
 LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');
