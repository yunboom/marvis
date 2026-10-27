package handler

import (
	"context"
	"os"
	"strings"
	"testing"
)

// The default agent's avatar is copied onto the row at creation, so swapping
// mika_avatar.svg leaves existing agents on the old artwork unless a migration
// moves them. This fails when the embedded artwork changes without one.
const latestDefaultAvatarMigration = "../../migrations/601_refresh_marvis_default_avatar.up.sql"

func TestDefaultAvatarMigrationTargetsEmbeddedArtwork(t *testing.T) {
	migration, err := os.ReadFile(latestDefaultAvatarMigration)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(migration), "SET avatar_url = '"+mikaAgentAvatarURL+"'") {
		t.Fatalf("%s does not set the embedded mika_avatar.svg; add a migration that moves the previous default to it", latestDefaultAvatarMigration)
	}
}

func TestDefaultAvatarMigrationOnlyRewritesThePreviousDefault(t *testing.T) {
	ctx := context.Background()
	migration, err := os.ReadFile(latestDefaultAvatarMigration)
	if err != nil {
		t.Fatal(err)
	}

	// The first value in the IN list is a previous default artwork.
	_, rest, ok := strings.Cut(string(migration), "WHERE avatar_url IN (\n    '")
	if !ok {
		t.Fatal("migration has no previous default to match")
	}
	previousDefault, _, _ := strings.Cut(rest, "'")

	onOldDefault := createHandlerTestAgent(t, "Marvis on old artwork", nil)
	customised := createHandlerTestAgent(t, "Agent with its own avatar", nil)
	const customAvatar = "https://example.com/avatar.png"
	for id, avatar := range map[string]string{onOldDefault: previousDefault, customised: customAvatar} {
		if _, err := testPool.Exec(ctx, `UPDATE agent SET avatar_url = $1 WHERE id = $2`, avatar, id); err != nil {
			t.Fatal(err)
		}
	}

	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}

	avatarOf := func(id string) string {
		t.Helper()
		var avatar string
		if err := tx.QueryRow(ctx, `SELECT avatar_url FROM agent WHERE id = $1`, id).Scan(&avatar); err != nil {
			t.Fatal(err)
		}
		return avatar
	}
	if got := avatarOf(onOldDefault); got != mikaAgentAvatarURL {
		t.Errorf("agent on the previous default kept %.40q, want the embedded artwork", got)
	}
	if got := avatarOf(customised); got != customAvatar {
		t.Errorf("customised avatar became %.40q, want it untouched", got)
	}
}
