-- One change request per kb/* branch; creating a second one for the same branch is rejected.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS knowledge_change_request_workspace_branch_uidx
    ON knowledge_change_request (workspace_id, branch);
