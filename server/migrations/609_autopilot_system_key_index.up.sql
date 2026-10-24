-- One platform-owned autopilot per workspace and system key.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS autopilot_workspace_system_key_uidx
    ON autopilot (workspace_id, system_key) WHERE system_key IS NOT NULL;
