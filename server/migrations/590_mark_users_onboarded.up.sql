-- Users skip the onboarding flow (see CreateUser). Users created before that
-- change and never finished onboarding would otherwise stay gated behind a
-- flow clients no longer render.
UPDATE "user" SET onboarded_at = now(), updated_at = now()
WHERE onboarded_at IS NULL;
