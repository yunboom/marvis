-- Rebrand: Multica -> Marvis. Earlier migrations were edited in place to the
-- new names, so a fresh database already matches and every step below is a
-- no-op there. Databases migrated before the rebrand still carry the old
-- names, which the renamed application code no longer reads:
--   * columns such as lark_user_binding.multica_user_id;
--   * trigger functions and trigger WHEN clauses that read the
--     `multica.*` session settings the server now sets as `marvis.*`;
--   * the legacy cloud runtime provider value 'multica_agent'.
-- Objects are found from the catalog rather than listed, so any old name an
-- installation carries is covered. `multicast` is a different word and is
-- left alone.
DO $$
DECLARE
    r record;
    def text;
BEGIN
    FOR r IN
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attname ~* 'multica(?!st)'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I RENAME COLUMN %I TO %I',
            r.table_name,
            r.column_name,
            regexp_replace(r.column_name, 'multica(?!st)', 'marvis', 'g')
        );
    END LOOP;

    FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'i', 'I', 'S', 'v', 'm')
          AND c.relname ~* 'multica(?!st)'
    LOOP
        EXECUTE format(
            'ALTER %s public.%I RENAME TO %I',
            CASE r.relkind
                WHEN 'i' THEN 'INDEX'
                WHEN 'I' THEN 'INDEX'
                WHEN 'S' THEN 'SEQUENCE'
                WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW'
                ELSE 'TABLE'
            END,
            r.relname,
            regexp_replace(r.relname, 'multica(?!st)', 'marvis', 'g')
        );
    END LOOP;

    FOR r IN
        SELECT c.relname AS table_name, con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public'
          AND con.conname ~* 'multica(?!st)'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
            r.table_name,
            r.conname,
            regexp_replace(r.conname, 'multica(?!st)', 'marvis', 'g')
        );
    END LOOP;

    -- Function bodies: CREATE OR REPLACE keeps the oid, so triggers that
    -- execute these functions stay attached.
    FOR r IN
        SELECT p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.prosrc ~* 'multica(?!st)'
    LOOP
        def := pg_get_functiondef(r.oid);
        def := regexp_replace(def, 'multica(?!st)', 'marvis', 'g');
        def := regexp_replace(def, 'Multica(?!st)', 'Marvis', 'g');
        def := regexp_replace(def, 'MULTICA(?!ST)', 'MARVIS', 'g');
        EXECUTE def;
    END LOOP;

    -- Trigger WHEN clauses cannot be altered in place: drop and recreate.
    FOR r IN
        SELECT t.tgname, c.relname AS table_name, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND pg_get_triggerdef(t.oid) ~* 'multica(?!st)'
    LOOP
        EXECUTE format('DROP TRIGGER %I ON public.%I', r.tgname, r.table_name);
        EXECUTE regexp_replace(r.def, 'multica(?!st)', 'marvis', 'g');
    END LOOP;
END
$$;

UPDATE agent_runtime SET provider = 'marvis_agent' WHERE provider = 'multica_agent';
