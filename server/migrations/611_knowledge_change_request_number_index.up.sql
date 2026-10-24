-- Change request numbers are allocated per workspace.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS knowledge_change_request_workspace_number_uidx
    ON knowledge_change_request (workspace_id, number);
