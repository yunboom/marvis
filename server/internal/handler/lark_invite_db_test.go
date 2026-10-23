package handler

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// newLarkInviteParams 返回一条默认有效的邀请入参：群目标、7 天后过期、不限次数，调用方按需覆盖字段。
func newLarkInviteParams() db.CreateLarkInviteParams {
	seq := testSeq.Add(1)

	return db.CreateLarkInviteParams{
		WorkspaceID:  parseUUID(testWorkspaceID),
		TargetType:   "chat",
		TargetID:     fmt.Sprintf("oc_lark_invite_test_%d", seq),
		TargetIDType: "chat_id",
		TargetName:   "Test Chat",
		Role:         "member",
		ExpiresAt:    pgtype.Timestamptz{Time: time.Now().Add(7 * 24 * time.Hour), Valid: true},
		SentByUserID: parseUUID(testUserID),
	}
}

// createTestLarkInvite 插入一条邀请并在测试结束时连同加入记录一起清理。
// 邀请按接收方清理：唯一约束失效时测试里多插的重复行也不会残留。
func createTestLarkInvite(t *testing.T, params db.CreateLarkInviteParams) db.LarkInvite {
	t.Helper()

	invite, err := testHandler.Queries.CreateLarkInvite(context.Background(), params)
	if err != nil {
		t.Fatalf("create lark invite: %v", err)
	}

	dbfx.Cleanup(t, `DELETE FROM lark_invite WHERE workspace_id = $1 AND target_id = $2`, invite.WorkspaceID, invite.TargetID)
	dbfx.Cleanup(t, `DELETE FROM lark_invite_join WHERE invite_id = $1`, invite.ID)

	return invite
}

func TestClaimLarkInviteUse_RespectsLimitsAndRevocation(t *testing.T) {
	ctx := context.Background()
	q := testHandler.Queries

	t.Run("max_uses reached", func(t *testing.T) {
		params := newLarkInviteParams()
		params.MaxUses = pgtype.Int4{Int32: 1, Valid: true}
		invite := createTestLarkInvite(t, params)

		claimed, err := q.ClaimLarkInviteUse(ctx, invite.ID)
		if err != nil {
			t.Fatalf("first claim: %v", err)
		}
		if claimed.UseCount != 1 {
			t.Fatalf("use_count after first claim = %d, want 1", claimed.UseCount)
		}

		if _, err := q.ClaimLarkInviteUse(ctx, invite.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("second claim err = %v, want pgx.ErrNoRows", err)
		}

		stored, err := q.GetLarkInvite(ctx, invite.ID)
		if err != nil {
			t.Fatalf("get invite: %v", err)
		}
		if stored.UseCount != 1 {
			t.Fatalf("use_count after rejected claim = %d, want 1", stored.UseCount)
		}
	})

	t.Run("revoked", func(t *testing.T) {
		invite := createTestLarkInvite(t, newLarkInviteParams())

		revoked, err := q.RevokeLarkInvite(ctx, db.RevokeLarkInviteParams{ID: invite.ID, WorkspaceID: invite.WorkspaceID})
		if err != nil {
			t.Fatalf("revoke: %v", err)
		}
		if !revoked.RevokedAt.Valid {
			t.Fatal("revoked_at not set after revoke")
		}

		if _, err := q.ClaimLarkInviteUse(ctx, invite.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("claim of revoked invite err = %v, want pgx.ErrNoRows", err)
		}

		// 重复撤销不改写首次撤销时间，也没有返回行。
		if _, err := q.RevokeLarkInvite(ctx, db.RevokeLarkInviteParams{ID: invite.ID, WorkspaceID: invite.WorkspaceID}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("second revoke err = %v, want pgx.ErrNoRows", err)
		}
		stored, err := q.GetLarkInvite(ctx, invite.ID)
		if err != nil {
			t.Fatalf("get invite: %v", err)
		}
		if !stored.RevokedAt.Time.Equal(revoked.RevokedAt.Time) {
			t.Fatalf("revoked_at changed from %v to %v", revoked.RevokedAt.Time, stored.RevokedAt.Time)
		}
	})

	t.Run("expired", func(t *testing.T) {
		params := newLarkInviteParams()
		params.ExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true}
		invite := createTestLarkInvite(t, params)

		if _, err := q.ClaimLarkInviteUse(ctx, invite.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("claim of expired invite err = %v, want pgx.ErrNoRows", err)
		}
	})

	t.Run("unlimited uses", func(t *testing.T) {
		invite := createTestLarkInvite(t, newLarkInviteParams())

		for i := int32(1); i <= 3; i++ {
			claimed, err := q.ClaimLarkInviteUse(ctx, invite.ID)
			if err != nil {
				t.Fatalf("claim %d: %v", i, err)
			}
			if claimed.UseCount != i {
				t.Fatalf("use_count after claim %d = %d", i, claimed.UseCount)
			}
		}
	})
}

func TestLarkInviteIdempotencyKey_Unique(t *testing.T) {
	ctx := context.Background()
	q := testHandler.Queries

	params := newLarkInviteParams()
	params.IdempotencyKey = pgtype.Text{String: "key-1", Valid: true}
	first := createTestLarkInvite(t, params)

	// 同 workspace、同 target、同 key：违反唯一约束。
	_, err := q.CreateLarkInvite(ctx, params)
	if !isUniqueViolation(err) {
		t.Fatalf("duplicate idempotency key err = %v, want unique violation", err)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "idx_lark_invite_idempotency" {
		t.Fatalf("duplicate idempotency key err = %v, want violation of idx_lark_invite_idempotency", err)
	}

	found, err := q.GetLarkInviteByIdempotencyKey(ctx, db.GetLarkInviteByIdempotencyKeyParams{
		WorkspaceID:    params.WorkspaceID,
		TargetID:       params.TargetID,
		IdempotencyKey: params.IdempotencyKey,
	})
	if err != nil {
		t.Fatalf("get by idempotency key: %v", err)
	}
	if found.ID != first.ID {
		t.Fatalf("found invite %v, want %v", found.ID, first.ID)
	}

	// 同 key、不同 target：允许。
	other := newLarkInviteParams()
	other.IdempotencyKey = params.IdempotencyKey
	createTestLarkInvite(t, other)

	// 同 target、不同 key：允许。
	differentKey := params
	differentKey.IdempotencyKey = pgtype.Text{String: "key-2", Valid: true}
	createTestLarkInvite(t, differentKey)

	// key 为空不受限。
	noKey := newLarkInviteParams()
	createTestLarkInvite(t, noKey)
	createTestLarkInvite(t, noKey)
}

func TestLarkInviteJoin_WelcomeFlow(t *testing.T) {
	ctx := context.Background()
	q := testHandler.Queries

	invite := createTestLarkInvite(t, newLarkInviteParams())
	userID := createTestUserAndMember(t, "")
	userUUID := parseUUID(userID)

	join := db.CreateLarkInviteJoinParams{
		InviteID:    invite.ID,
		WorkspaceID: invite.WorkspaceID,
		UserID:      userUUID,
		LarkOpenID:  "ou_join_test",
	}
	if err := q.CreateLarkInviteJoin(ctx, join); err != nil {
		t.Fatalf("create join: %v", err)
	}

	// 同一人重复加入同一邀请：违反唯一约束。
	if err := q.CreateLarkInviteJoin(ctx, join); !isUniqueViolation(err) {
		t.Fatalf("duplicate join err = %v, want unique violation", err)
	}

	joins, err := q.ListLarkInviteJoinsByInviteIDs(ctx, []pgtype.UUID{invite.ID, parseUUID(testUserID)})
	if err != nil {
		t.Fatalf("list joins: %v", err)
	}
	if len(joins) != 1 || joins[0].UserID != userUUID || joins[0].UserName == "" || joins[0].UserEmail == "" {
		t.Fatalf("joins = %+v, want one row for user %s with name and email", joins, userID)
	}

	welcome, err := q.GetPendingLarkInviteWelcome(ctx, db.GetPendingLarkInviteWelcomeParams{
		UserID:      userUUID,
		WorkspaceID: invite.WorkspaceID,
	})
	if err != nil {
		t.Fatalf("get pending welcome: %v", err)
	}
	if welcome.InviteID != invite.ID || welcome.Role != invite.Role || welcome.InviterName != handlerTestName {
		t.Fatalf("welcome = %+v, want invite %v role %q inviter %q", welcome, invite.ID, invite.Role, handlerTestName)
	}

	if err := q.MarkLarkInviteWelcomed(ctx, db.MarkLarkInviteWelcomedParams{
		UserID:      userUUID,
		WorkspaceID: invite.WorkspaceID,
	}); err != nil {
		t.Fatalf("mark welcomed: %v", err)
	}
	if _, err := q.GetPendingLarkInviteWelcome(ctx, db.GetPendingLarkInviteWelcomeParams{
		UserID:      userUUID,
		WorkspaceID: invite.WorkspaceID,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("pending welcome after ack err = %v, want pgx.ErrNoRows", err)
	}
}
