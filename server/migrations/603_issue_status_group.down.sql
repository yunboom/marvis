SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE issue_status
    DROP CONSTRAINT IF EXISTS issue_status_system_group,
    DROP CONSTRAINT IF EXISTS issue_status_group_check;

DROP TRIGGER IF EXISTS issue_status_fill_group ON issue_status;
DROP FUNCTION IF EXISTS issue_status_fill_group();

ALTER TABLE issue_status DROP COLUMN IF EXISTS status_group;

DROP FUNCTION IF EXISTS issue_status_default_group(TEXT, TEXT);
