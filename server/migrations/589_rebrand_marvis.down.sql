-- Reverts 589_rebrand_marvis: renames every catalog object and session-setting
-- reference containing "marvis" back to "multica", restoring the names the
-- pre-rebrand application code reads.
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
          AND a.attname ~* 'marvis'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I RENAME COLUMN %I TO %I',
            r.table_name,
            r.column_name,
            regexp_replace(r.column_name, 'marvis', 'multica', 'g')
        );
    END LOOP;

    FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'i', 'I', 'S', 'v', 'm')
          AND c.relname ~* 'marvis'
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
            regexp_replace(r.relname, 'marvis', 'multica', 'g')
        );
    END LOOP;

    FOR r IN
        SELECT c.relname AS table_name, con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public'
          AND con.conname ~* 'marvis'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
            r.table_name,
            r.conname,
            regexp_replace(r.conname, 'marvis', 'multica', 'g')
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
          AND p.prosrc ~* 'marvis'
    LOOP
        def := pg_get_functiondef(r.oid);
        def := regexp_replace(def, 'marvis', 'multica', 'g');
        def := regexp_replace(def, 'Marvis', 'Multica', 'g');
        def := regexp_replace(def, 'MARVIS', 'MULTICA', 'g');
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
          AND pg_get_triggerdef(t.oid) ~* 'marvis'
    LOOP
        EXECUTE format('DROP TRIGGER %I ON public.%I', r.tgname, r.table_name);
        EXECUTE regexp_replace(r.def, 'marvis', 'multica', 'g');
    END LOOP;
END
$$;

UPDATE agent_runtime SET provider = 'multica_agent' WHERE provider = 'marvis_agent';
