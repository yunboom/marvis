package handler

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// 成员写入来源，只用于日志。
const admitSourceShareLink = "share_link"

// admitActorTypeMember 是成员加入事件的发起方类型。
const admitActorTypeMember = "member"

// errAdmitAlreadyMember 表示用户已是该工作区成员。
var errAdmitAlreadyMember = errors.New("user is already a member of this workspace")

// errAdmitClaimRejected 表示名额已用完、已过期或已撤销，本次加入不成立。
var errAdmitClaimRejected = errors.New("admission claim rejected")

// admitStep 标识成员写入事务里出错的步骤，调用方据此保留各自的响应文案。
type admitStep string

// 需要调用方单独区分的出错步骤；其余步骤出错时不带步骤标记。
const (
	admitStepClaim         admitStep = "claim"
	admitStepCreateMember  admitStep = "create_member"
	admitStepMarkOnboarded admitStep = "mark_onboarded"
)

// admitStepError 给错误附上出错步骤；Unwrap 保留原错误，errors.Is / errors.As 仍能穿透。
type admitStepError struct {
	step admitStep
	err  error
}

func (e *admitStepError) Error() string {
	return string(e.step) + ": " + e.err.Error()
}

func (e *admitStepError) Unwrap() error {
	return e.err
}

// admitFailedStep 返回 err 上标记的出错步骤，没有标记时返回空串。
func admitFailedStep(err error) admitStep {
	var stepErr *admitStepError
	if errors.As(err, &stepErr) {
		return stepErr.step
	}

	return ""
}

// admitMemberInput 是 admitWorkspaceMember 的入参。
type admitMemberInput struct {
	WorkspaceID    pgtype.UUID
	User           db.User
	Role           string
	CapacityToken  uuid.UUID // 席位容量关闭时为 uuid.Nil
	CapacityAction string
	// Claim 在同一事务里占用一次名额；名额用完、过期、撤销时返回 errAdmitClaimRejected。
	Claim func(ctx context.Context, qtx *db.Queries) error
	// AfterCreate 在同一事务里、成员写入之后执行（飞书邀请用来写 lark_invite_join），可为 nil。
	AfterCreate func(ctx context.Context, qtx *db.Queries, member db.Member) error
	Source      string // 日志用，如 "share_link"、"lark_invite"
}

// admitWorkspaceMember 在一个事务里把用户写入工作区成员，分享链接和飞书邀请卡片共用。
//
// 事务内依次执行：Claim 占用名额 → 已是成员检查 → 结清同邮箱待接受邀请 → 写成员
// → 标记 onboarding → 席位意图转确认 → AfterCreate → 提交。提交后确认席位、
// 发布 member_added / invitation_accepted 事件并通知 daemon 刷新工作区。
//
// 已是成员返回 errAdmitAlreadyMember；Claim 的错误带 admitStepClaim 标记返回，
// 名额被拒时可用 errors.Is 匹配 errAdmitClaimRejected；AfterCreate 的错误原样返回。
// 两个回调的错误由回调自己负责包装。
func (h *Handler) admitWorkspaceMember(ctx context.Context, in admitMemberInput) (db.Member, error) {
	wsID := uuidToString(in.WorkspaceID)
	userID := uuidToString(in.User.ID)

	// 先开事务再占用名额：Claim 是带条件的原子更新，并发加入不会超过上限，
	// 也不会越过撤销或过期。
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.Member{}, errors.Wrapf(err, "begin admission tx workspace_id=%s user_id=%s", wsID, userID)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := h.Queries.WithTx(tx)

	if err := in.Claim(ctx, qtx); err != nil {
		return db.Member{}, &admitStepError{step: admitStepClaim, err: err}
	}

	// 已是成员时直接返回，事务回滚会退还刚占用的名额。
	_, memberErr := qtx.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		UserID:      in.User.ID,
		WorkspaceID: in.WorkspaceID,
	})
	if memberErr == nil {
		return db.Member{}, errAdmitAlreadyMember
	}
	if !errors.Is(memberErr, pgx.ErrNoRows) {
		return db.Member{}, errors.Wrapf(memberErr, "check membership workspace_id=%s user_id=%s", wsID, userID)
	}

	settledInvitationID, err := settlePendingInvitationForAdmission(ctx, qtx, in.WorkspaceID, in.User.Email)
	if err != nil {
		return db.Member{}, err
	}

	member, err := qtx.CreateMember(ctx, db.CreateMemberParams{
		WorkspaceID: in.WorkspaceID,
		UserID:      in.User.ID,
		Role:        in.Role,
	})
	if err != nil {
		if isUniqueViolation(err) {
			h.compensateCapacityIntent(ctx, in.CapacityToken)
			return db.Member{}, errAdmitAlreadyMember
		}

		return db.Member{}, &admitStepError{
			step: admitStepCreateMember,
			err:  errors.Wrapf(err, "create member workspace_id=%s user_id=%s", wsID, userID),
		}
	}

	// onboarding 标记失败必须让整次加入回滚，否则首次登录的用户会成为成员却仍卡在 onboarding。
	if _, err := qtx.MarkUserOnboarded(ctx, in.User.ID); err != nil {
		return db.Member{}, &admitStepError{
			step: admitStepMarkOnboarded,
			err:  errors.Wrapf(err, "mark user onboarded user_id=%s", userID),
		}
	}

	if in.CapacityToken != uuid.Nil {
		if err := transitionCapacityIntentToConfirm(ctx, qtx, in.CapacityToken, uuid.UUID(member.ID.Bytes), in.CapacityAction); err != nil {
			return db.Member{}, errors.Wrapf(err, "confirm capacity intent workspace_id=%s operation_token=%s", wsID, in.CapacityToken)
		}
	}
	if settledInvitationID.Valid && h.seatCapacityEnabled() {
		// 被结清的邀请占着一个席位预留（托管模式）；本次加入自己的席位确认已覆盖这个席位，
		// 所以释放邀请的预留，避免同一个人占两个席位。
		if err := enqueueCapacityRelease(ctx, qtx, uuid.UUID(in.WorkspaceID.Bytes), uuid.UUID(settledInvitationID.Bytes)); err != nil {
			return db.Member{}, errors.Wrapf(err, "enqueue invitation capacity release invitation_id=%s", uuidToString(settledInvitationID))
		}
	}

	if in.AfterCreate != nil {
		if err := in.AfterCreate(ctx, qtx, member); err != nil {
			return db.Member{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return db.Member{}, errors.Wrapf(err, "commit admission workspace_id=%s user_id=%s", wsID, userID)
	}

	h.finishAdmission(ctx, in, member, settledInvitationID)

	return member, nil
}

// settlePendingInvitationForAdmission 在同一事务里结清同邮箱的待接受邀请（#8432），
// 返回被结清的邀请 id，没有可结清的邀请时返回无效值。
//
// 用户被邮件邀请后改走其他入口加入，若不结清，这条邀请会一直 pending：继续占着席位预留、
// 留在待接受列表里，之后再接受会撞上 CreateMember 的 409。成员角色以本次入口为准，
// 邀请行只改状态、不改角色。idx_invitation_unique_pending 保证同一工作区同一邮箱
// 最多一条 pending 邀请。
func settlePendingInvitationForAdmission(ctx context.Context, qtx *db.Queries, workspaceID pgtype.UUID, email string) (pgtype.UUID, error) {
	pendingInv, err := qtx.GetPendingInvitationByEmail(ctx, db.GetPendingInvitationByEmailParams{
		WorkspaceID:  workspaceID,
		InviteeEmail: strings.ToLower(email),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// 没有同邮箱的待接受邀请，最常见的情况。
		return pgtype.UUID{}, nil
	}
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "load pending invitation workspace_id=%s", uuidToString(workspaceID))
	}

	// AcceptInvitation 在行锁下复核 status='pending'；邀请刚被并发拒绝时没有可结清的，加入照常进行。
	settled, err := qtx.AcceptInvitation(ctx, pendingInv.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		// 期间已在别处结束，席位由那条路径释放。
		return pgtype.UUID{}, nil
	}
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "settle pending invitation invitation_id=%s", uuidToString(pendingInv.ID))
	}

	return settled.ID, nil
}

// finishAdmission 处理成员写入提交后的收尾：确认席位、释放被结清邀请的席位预留、
// 发布事件并通知 daemon 刷新工作区。
func (h *Handler) finishAdmission(ctx context.Context, in admitMemberInput, member db.Member, settledInvitationID pgtype.UUID) {
	wsID := uuidToString(in.WorkspaceID)
	userID := uuidToString(in.User.ID)

	if in.CapacityToken != uuid.Nil {
		h.confirmCapacityIntent(ctx, uuid.UUID(in.WorkspaceID.Bytes), in.CapacityToken, uuid.UUID(member.ID.Bytes))
	}
	if settledInvitationID.Valid && h.seatCapacityEnabled() {
		// 尽力立即释放被结清邀请的席位预留；席位服务不可用时由 outbox worker 重试事务里登记的释放。
		h.compensateCapacityIntent(ctx, uuid.UUID(settledInvitationID.Bytes))
	}

	slog.Info("user joined workspace", "source", in.Source, "user_id", userID, "workspace_id", wsID)

	memberResp := h.memberWithUserResponse(member, in.User)
	h.publish(protocol.EventMemberAdded, wsID, admitActorTypeMember, userID, map[string]any{
		"member": memberResp,
	})
	if settledInvitationID.Valid {
		// 与接受邀请路径发同一个信号：管理员刷新待接受邀请列表，加入者自己的客户端同步。
		h.publish(protocol.EventInvitationAccepted, wsID, admitActorTypeMember, userID, map[string]any{
			"invitation_id": uuidToString(settledInvitationID),
			"member":        memberResp,
		})
	}
	h.notifyDaemonWorkspacesChanged(userID)
}
