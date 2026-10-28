-- Where a conversation is shown, independent of which agent runs it. Only
-- 'chat' sessions appear in chat surfaces (chat list, unread, running
-- indicator, workspace chat list); a knowledge base job's chat, an autopilot
-- run's follow-up chat and the two builder conversations live on their own
-- pages.
ALTER TABLE chat_session ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE chat_session DROP CONSTRAINT IF EXISTS chat_session_source_check;
ALTER TABLE chat_session ADD CONSTRAINT chat_session_source_check
    CHECK (source IN ('chat', 'kb_job', 'autopilot_run', 'kb_builder', 'agent_builder'));

-- Backfill. Each statement only claims rows still at the default, so a
-- session referenced from two places keeps the first match below.
UPDATE chat_session cs SET source = 'kb_job'
 WHERE cs.source = 'chat'
   AND EXISTS (SELECT 1 FROM kb_job j WHERE j.chat_session_id = cs.id);

UPDATE chat_session cs SET source = 'autopilot_run'
 WHERE cs.source = 'chat'
   AND EXISTS (SELECT 1 FROM autopilot_run r WHERE r.chat_session_id = cs.id);

UPDATE chat_session cs SET source = 'kb_builder'
 WHERE cs.source = 'chat'
   AND EXISTS (SELECT 1 FROM kb_builder_session s WHERE s.chat_session_id = cs.id);

UPDATE chat_session cs SET source = 'agent_builder'
 WHERE cs.source = 'chat'
   AND (
     EXISTS (SELECT 1 FROM agent_builder_draft d WHERE d.chat_session_id = cs.id)
     OR EXISTS (
       SELECT 1 FROM agent a
        WHERE a.id = cs.agent_id
          AND a.kind = 'system'
          AND a.system_key LIKE 'agent_builder:%'
     )
   );
