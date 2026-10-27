-- Follow-up conversation of a run_only autopilot run. Soft reference to
-- chat_session.id: no foreign key, cleanup happens in application code.
ALTER TABLE autopilot_run ADD COLUMN IF NOT EXISTS chat_session_id UUID;
