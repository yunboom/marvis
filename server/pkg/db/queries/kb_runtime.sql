-- Knowledge bases on the agent runtime brief (spec 8.2).

-- name: ListKbBaseBriefs :many
-- The knowledge bases a task claim lists, by name; callers pass one more
-- than they show to learn whether the list was cut.
SELECT slug, name, description FROM kb_base
WHERE workspace_id = $1 AND deleted_at IS NULL
ORDER BY name, slug
LIMIT $2;
