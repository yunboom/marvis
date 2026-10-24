package handler

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/seatcapacity"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// admitTestFixture 准备一个测试用户和一条最多可用 maxUses 次的分享链接；memberRole 非空时用户已是测试工作区成员。
func admitTestFixture(t *testing.T, memberRole string, maxUses int32) (db.User, db.WorkspaceShareLink) {
	t.Helper()

	clearShareLinksForTestWorkspace(t)
	link := createTestShareLink(t, testWorkspaceID, "member", maxUses, 0)
	userID := createTestUserAndMember(t, memberRole)

	user, err := testHandler.Queries.GetUser(context.Background(), parseUUID(userID))
	if err != nil {
		t.Fatalf("load admit test user: %v", err)
	}

	return user, link
}

// admitTestInput 以分享链接认领作为 Claim，关闭席位容量。
func admitTestInput(user db.User, link db.WorkspaceShareLink) admitMemberInput {
	return admitMemberInput{
		WorkspaceID:    link.WorkspaceID,
		User:           user,
		Role:           link.Role,
		CapacityToken:  uuid.Nil,
		CapacityAction: seatcapacity.ActionClaimShareJoin,
		Claim:          claimShareLink(link.ID),
		Source:         admitSourceShareLink,
	}
}

func admitMemberCount(t *testing.T, user db.User) int {
	t.Helper()

	return dbfx.Count(t,
		`SELECT count(*) FROM member WHERE workspace_id = $1 AND user_id = $2`,
		parseUUID(testWorkspaceID), user.ID,
	)
}

func admitLinkUseCount(t *testing.T, link db.WorkspaceShareLink) int32 {
	t.Helper()

	var useCount int32
	dbfx.QueryRow(t, `SELECT use_count FROM workspace_share_link WHERE id = $1`, link.ID).Scan(&useCount)

	return useCount
}

func admitUserOnboarded(t *testing.T, user db.User) bool {
	t.Helper()

	var onboarded bool
	dbfx.QueryRow(t, `SELECT onboarded_at IS NOT NULL FROM "user" WHERE id = $1`, user.ID).Scan(&onboarded)

	return onboarded
}

// 名额已用完时 Claim 返回 errAdmitClaimRejected，不写成员，也不执行 AfterCreate。
func TestAdmitWorkspaceMember_ClaimRejectedLeavesNoMember(t *testing.T) {
	user, link := admitTestFixture(t, "", 1)
	dbfx.Exec(t, `UPDATE workspace_share_link SET use_count = 1 WHERE id = $1`, link.ID)

	afterCreateCalled := false
	in := admitTestInput(user, link)
	in.AfterCreate = func(context.Context, *db.Queries, db.Member) error {
		afterCreateCalled = true
		return nil
	}

	_, err := testHandler.admitWorkspaceMember(context.Background(), in)
	if !errors.Is(err, errAdmitClaimRejected) {
		t.Fatalf("err = %v, want errAdmitClaimRejected", err)
	}

	if n := admitMemberCount(t, user); n != 0 {
		t.Fatalf("member rows = %d, want 0", n)
	}
	if afterCreateCalled {
		t.Fatalf("AfterCreate ran after a rejected claim")
	}
	if admitUserOnboarded(t, user) {
		t.Fatalf("user marked onboarded after a rejected claim")
	}
}

// AfterCreate 出错时，成员、Claim 占用的名额和 onboarding 标记一起回滚，错误原样带回调用方。
func TestAdmitWorkspaceMember_AfterCreateErrorRollsBack(t *testing.T) {
	user, link := admitTestFixture(t, "", 5)

	errAfterCreate := errors.New("after create failed")
	in := admitTestInput(user, link)
	in.AfterCreate = func(context.Context, *db.Queries, db.Member) error {
		return errAfterCreate
	}

	_, err := testHandler.admitWorkspaceMember(context.Background(), in)
	if !errors.Is(err, errAfterCreate) {
		t.Fatalf("err = %v, want the AfterCreate error", err)
	}

	if n := admitMemberCount(t, user); n != 0 {
		t.Fatalf("member rows = %d, want 0 after rollback", n)
	}
	if useCount := admitLinkUseCount(t, link); useCount != 0 {
		t.Fatalf("use_count = %d, want 0 after rollback", useCount)
	}
	if admitUserOnboarded(t, user) {
		t.Fatalf("onboarding mark survived the rollback")
	}
}

// AfterCreate 与成员写入在同一事务内：事务内能读到新成员，提交前事务外读不到。
func TestAdmitWorkspaceMember_AfterCreateRunsInSameTransaction(t *testing.T) {
	user, link := admitTestFixture(t, "", 5)

	var seenMemberID string
	in := admitTestInput(user, link)
	in.AfterCreate = func(ctx context.Context, qtx *db.Queries, member db.Member) error {
		inTx, err := qtx.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID: user.ID, WorkspaceID: link.WorkspaceID,
		})
		if err != nil {
			return errors.WithStack(err)
		}
		if inTx.ID != member.ID {
			return errors.New("member read inside the transaction differs from the created one")
		}
		if n := admitMemberCount(t, user); n != 0 {
			return errors.New("member visible outside the transaction before commit")
		}

		seenMemberID = uuidToString(member.ID)

		return nil
	}

	member, err := testHandler.admitWorkspaceMember(context.Background(), in)
	if err != nil {
		t.Fatalf("admit: %v", err)
	}

	if uuidToString(member.ID) != seenMemberID {
		t.Fatalf("returned member %s, AfterCreate saw %q", uuidToString(member.ID), seenMemberID)
	}
	if member.Role != link.Role {
		t.Fatalf("member role = %q, want %q", member.Role, link.Role)
	}
	if n := admitMemberCount(t, user); n != 1 {
		t.Fatalf("member rows = %d, want 1", n)
	}
	if useCount := admitLinkUseCount(t, link); useCount != 1 {
		t.Fatalf("use_count = %d, want 1", useCount)
	}
	if !admitUserOnboarded(t, user) {
		t.Fatalf("user not marked onboarded")
	}
}

// 已是成员时返回 errAdmitAlreadyMember，Claim 占用的名额随事务回滚。
func TestAdmitWorkspaceMember_AlreadyMemberRollsBackClaim(t *testing.T) {
	user, link := admitTestFixture(t, "member", 5)

	_, err := testHandler.admitWorkspaceMember(context.Background(), admitTestInput(user, link))
	if !errors.Is(err, errAdmitAlreadyMember) {
		t.Fatalf("err = %v, want errAdmitAlreadyMember", err)
	}

	if useCount := admitLinkUseCount(t, link); useCount != 0 {
		t.Fatalf("use_count = %d, want 0 after rollback", useCount)
	}
}

// AfterCreate 自己的唯一冲突（如重复的 lark_invite_join）原样返回，不被当成「已是成员」。
func TestAdmitWorkspaceMember_AfterCreateUniqueViolationPassesThrough(t *testing.T) {
	user, link := admitTestFixture(t, "", 5)

	in := admitTestInput(user, link)
	in.AfterCreate = func(ctx context.Context, qtx *db.Queries, member db.Member) error {
		_, err := qtx.CreateMember(ctx, db.CreateMemberParams{
			WorkspaceID: member.WorkspaceID, UserID: member.UserID, Role: member.Role,
		})

		return errors.WithStack(err)
	}

	_, err := testHandler.admitWorkspaceMember(context.Background(), in)
	if errors.Is(err, errAdmitAlreadyMember) {
		t.Fatalf("AfterCreate unique violation reported as errAdmitAlreadyMember")
	}
	if !isUniqueViolation(err) {
		t.Fatalf("err = %v, want the AfterCreate unique violation", err)
	}

	if n := admitMemberCount(t, user); n != 0 {
		t.Fatalf("member rows = %d, want 0 after rollback", n)
	}
}
