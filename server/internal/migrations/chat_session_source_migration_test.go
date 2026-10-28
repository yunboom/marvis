package migrations

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const chatSessionSourceMigrationTestSchema = "chat_session_source_migration_test"

// TestChatSessionSourceMigrationBackfill seeds one session of every kind
// before 650 runs and checks the source each one is backfilled to.
func TestChatSessionSourceMigrationBackfill(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to Postgres: %v", err)
	}
	t.Cleanup(pool.Close)

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire Postgres connection: %v", err)
	}
	defer conn.Release()

	cleanup := func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+chatSessionSourceMigrationTestSchema+" CASCADE")
	}
	cleanup()
	t.Cleanup(cleanup)
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+chatSessionSourceMigrationTestSchema); err != nil {
		t.Fatalf("create isolated migration schema: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('search_path', $1, false)`, chatSessionSourceMigrationTestSchema); err != nil {
		t.Fatalf("set isolated migration search path: %v", err)
	}

	// Session ids: 1 plain chat, 2 kb job, 3 run follow-up, 4 kb builder,
	// 5 agent builder with a draft, 6 agent builder carrier without a draft,
	// 7 a chat with another system agent.
	if _, err := conn.Exec(ctx, `
		CREATE TABLE agent (id INT PRIMARY KEY, kind TEXT NOT NULL, system_key TEXT);
		CREATE TABLE chat_session (id INT PRIMARY KEY, agent_id INT NOT NULL);
		CREATE TABLE kb_job (chat_session_id INT NOT NULL);
		CREATE TABLE autopilot_run (chat_session_id INT);
		CREATE TABLE kb_builder_session (chat_session_id INT NOT NULL);
		CREATE TABLE agent_builder_draft (chat_session_id INT NOT NULL);

		INSERT INTO agent VALUES
			(1, 'user', NULL),
			(2, 'system', 'agent_builder:abc'),
			(3, 'system', 'mika');
		INSERT INTO chat_session VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 2), (6, 2), (7, 3);
		INSERT INTO kb_job VALUES (2);
		INSERT INTO autopilot_run VALUES (3), (NULL);
		INSERT INTO kb_builder_session VALUES (4);
		INSERT INTO agent_builder_draft VALUES (5);
	`); err != nil {
		t.Fatalf("create pre-migration fixture: %v", err)
	}

	applyMigrationFile(t, ctx, conn, "650_chat_session_source.up.sql")

	want := map[int]string{
		1: "chat",
		2: "kb_job",
		3: "autopilot_run",
		4: "kb_builder",
		5: "agent_builder",
		6: "agent_builder",
		7: "chat",
	}
	rows, err := conn.Query(ctx, `SELECT id, source FROM chat_session ORDER BY id`)
	if err != nil {
		t.Fatalf("read backfilled sources: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var id int
		var source string
		if err := rows.Scan(&id, &source); err != nil {
			t.Fatalf("scan source: %v", err)
		}
		seen++
		if source != want[id] {
			t.Errorf("session %d source = %q, want %q", id, source, want[id])
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate sources: %v", err)
	}
	if seen != len(want) {
		t.Fatalf("sessions read = %d, want %d", seen, len(want))
	}

	if _, err := conn.Exec(ctx, `INSERT INTO chat_session (id, agent_id) VALUES (8, 1)`); err != nil {
		t.Fatalf("insert without source: %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO chat_session (id, agent_id, source) VALUES (9, 1, 'issue')`); !isCheckViolation(err) {
		t.Fatalf("insert unknown source: got %v, want check violation", err)
	}

	// Re-running is harmless and the down migration drops the column.
	applyMigrationFile(t, ctx, conn, "650_chat_session_source.up.sql")
	applyMigrationFile(t, ctx, conn, "650_chat_session_source.down.sql")
	var columns int
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = 'chat_session' AND column_name = 'source'
	`, chatSessionSourceMigrationTestSchema).Scan(&columns); err != nil {
		t.Fatalf("inspect columns: %v", err)
	}
	if columns != 0 {
		t.Fatalf("source column survives the down migration")
	}
}
