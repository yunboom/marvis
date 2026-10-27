-- Status group: how a status is arranged on the board and in the status
-- library (not_started / working / needs_attention / ended). It is display
-- data only; category stays the lifecycle that drives platform behavior.
-- Every pair is pinned to its category, and built-ins to their fixed group.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE issue_status ADD COLUMN IF NOT EXISTS status_group TEXT;

-- The group a status gets when its writer does not choose one: in_review and
-- blocked wait on a person, every other started status is working.
CREATE OR REPLACE FUNCTION issue_status_default_group(p_key TEXT, p_category TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
    SELECT CASE p_category
        WHEN 'unstarted' THEN 'not_started'
        WHEN 'started' THEN CASE WHEN p_key IN ('in_review', 'blocked') THEN 'needs_attention' ELSE 'working' END
        WHEN 'done' THEN 'ended'
        WHEN 'closed' THEN 'ended'
    END
$function$;

UPDATE issue_status
SET status_group = issue_status_default_group(key, category)
WHERE status_group IS NULL;

CREATE OR REPLACE FUNCTION issue_status_fill_group()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
    IF NEW.status_group IS NULL THEN
        NEW.status_group := issue_status_default_group(NEW.key, NEW.category);
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS issue_status_fill_group ON issue_status;
CREATE TRIGGER issue_status_fill_group
    BEFORE INSERT ON issue_status
    FOR EACH ROW EXECUTE FUNCTION issue_status_fill_group();

ALTER TABLE issue_status
    ALTER COLUMN status_group SET NOT NULL,
    DROP CONSTRAINT IF EXISTS issue_status_group_check,
    DROP CONSTRAINT IF EXISTS issue_status_system_group,
    ADD CONSTRAINT issue_status_group_check CHECK (
        (category = 'unstarted' AND status_group = 'not_started')
        OR (category = 'started' AND status_group IN ('working', 'needs_attention'))
        OR (category IN ('done', 'closed') AND status_group = 'ended')
    ),
    ADD CONSTRAINT issue_status_system_group CHECK (
        NOT is_system OR status_group = issue_status_default_group(key, category)
    );
