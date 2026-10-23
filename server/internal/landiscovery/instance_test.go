package landiscovery

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const createInstanceStateTableSQL = `
	CREATE TABLE instance_telemetry_state (
		singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
		instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
		updated_at timestamptz NOT NULL DEFAULT now()
	)`

// instanceTestPool 在独立 schema 里建一个连接池，没有 DATABASE_URL 时跳过。
func instanceTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping live-Postgres LAN discovery test")
	}

	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}

	schema := fmt.Sprintf("landiscovery_%d_%d", time.Now().UnixNano(), rand.Uint32())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = make(map[string]string)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}

	t.Cleanup(func() {
		pool.Close()

		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Logf("drop landiscovery test schema: %v", err)
		}
		admin.Close()
	})

	return pool
}

func TestLoadInstanceID(t *testing.T) {
	pool := instanceTestPool(t)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, createInstanceStateTableSQL); err != nil {
		t.Fatal(err)
	}

	// 行不存在时创建，并且重复读取返回同一个 ID。
	first, err := LoadInstanceID(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(first); err != nil {
		t.Fatalf("LoadInstanceID() = %q, want a UUID: %v", first, err)
	}

	second, err := LoadInstanceID(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("instance id changed between calls: %s != %s", second, first)
	}

	// 已有行时直接返回行里的 ID。
	existing := uuid.NewString()
	if _, err := pool.Exec(ctx, "UPDATE instance_telemetry_state SET instance_id = $1", existing); err != nil {
		t.Fatal(err)
	}

	got, err := LoadInstanceID(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if got != existing {
		t.Fatalf("LoadInstanceID() = %s, want existing %s", got, existing)
	}
}

func TestLoadInstanceIDMissingTable(t *testing.T) {
	pool := instanceTestPool(t)

	if _, err := LoadInstanceID(context.Background(), pool); err == nil {
		t.Fatal("LoadInstanceID() succeeded without instance_telemetry_state table")
	}
}
