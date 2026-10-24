package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/analytics"
	"github.com/yunboom/marvis/server/internal/auth"
	"github.com/yunboom/marvis/server/internal/integrations/lark"
	obsmetrics "github.com/yunboom/marvis/server/internal/metrics"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// 本文件处理飞书邀请卡片上“加入工作区”按钮的点击回调：识别点击人，找到或新建账号，加入工作区，
// 在飞书要求的 3 秒内回应提示。群卡片的已加入人数、失效卡片在回应之后异步更新。

// admitSourceLarkInvite 是飞书邀请卡片加入的成员写入来源，只用于日志。
const admitSourceLarkInvite = "lark_invite"

// 点击回调的提示文案。
const (
	// larkInviteMsgJoinedFormat 的参数是工作区名。
	larkInviteMsgJoinedFormat = "已加入 %s，打开 Marvis 用飞书登录即可"
	// larkInviteMsgAlreadyMemberFormat 的参数是工作区名。
	larkInviteMsgAlreadyMemberFormat = "你已在 %s 中"
	larkInviteMsgInvalid             = "邀请已失效"
	larkInviteMsgFull                = "邀请人数已满"
	larkInviteMsgTenantNotAllowed    = "此邀请仅限本组织成员"
	larkInviteMsgNotInvitee          = "此邀请仅限受邀人使用"
	larkInviteMsgNoEmail             = "飞书账号没有邮箱，无法加入"
	larkInviteMsgSignupProhibited    = "当前服务器不允许注册新账号"
	larkInviteMsgNotInAppScope       = "你不在 Marvis 应用的可用范围内，请联系管理员"
	larkInviteMsgUserNotFound        = "未找到你的飞书账号信息，请联系管理员"
	larkInviteMsgAccountDisabled     = "账号已停用，请联系管理员"
	larkInviteMsgFailed              = "加入失败，请稍后重试"
)

// 点击回调的时限。
const (
	// larkInviteContactTimeout 是查点击人通讯录资料的时限。长连接给回调 2.5 秒，
	// 通讯录接口超时后还要留出写库和回应的时间。
	larkInviteContactTimeout = 1500 * time.Millisecond
	// larkInvitePatchTimeout 是更新卡片的时限：点击回应之后的异步更新，以及撤销之后的更新。
	// 两者都不跟随调用方的 ctx 取消，靠它兜底。
	larkInvitePatchTimeout = 10 * time.Second
)

// larkInviteEmptyResponse 是不处理的回调（其他按钮、无法解析的载荷）的回应，飞书收到后卡片不变。
const larkInviteEmptyResponse = "{}"

// errLarkInviteGone 表示被点击的邀请已不存在，或它所在的工作区已删除。
var errLarkInviteGone = errors.New("lark invite is gone")

// errLarkInviteJoinExists 表示这个人以前通过这张邀请加入过（之后被移出了工作区），加入记录已存在。
var errLarkInviteJoinExists = errors.New("lark invite join already exists")

// larkInviteCardActionEvent 是飞书 card.action.trigger 回调（schema 2.0）里用到的字段。
type larkInviteCardActionEvent struct {
	Event struct {
		Operator struct {
			OpenID    string `json:"open_id"`
			TenantKey string `json:"tenant_key"`
		} `json:"operator"`
		Action struct {
			Value larkInviteCallbackData `json:"value"`
		} `json:"action"`
		Context struct {
			OpenMessageID string `json:"open_message_id"`
		} `json:"context"`
	} `json:"event"`
}

// larkInviteClick 是一次“加入工作区”点击。
type larkInviteClick struct {
	InviteID string
	OpenID   string
	// TenantKey 是点击人的组织，取自回调的 event.operator；通讯录接口不返回组织。
	TenantKey string
	// MessageID 是被点击的消息；邀请行没有记下消息 ID 时，卡片更新发往这条消息。
	MessageID string
}

// larkInviteReply 是一次点击的回应：提示，以及可选的替换卡片。
type larkInviteReply struct {
	Kind    string
	Content string
	// Card 非空时用它替换被点击的卡片。
	Card *larkInviteCardView
}

// HandleLarkInviteCardAction 是长连接的 CardActionHandler，处理“加入工作区”点击，返回飞书回应 JSON。
//
// 其他按钮和无法解析的载荷回空回应。预期内的拒绝回对应提示；意外错误在这里记日志（本函数是这条回调的
// 最上层，长连接收到 error 时只会回空回应），并回“加入失败，请稍后重试”。返回的 error 只来自回应本身无法生成。
func (h *Handler) HandleLarkInviteCardAction(ctx context.Context, payload []byte) ([]byte, error) {
	click, ok := parseLarkInviteClick(payload)
	if !ok {
		return []byte(larkInviteEmptyResponse), nil
	}

	reply, err := h.answerLarkInviteClick(ctx, click)
	if err != nil {
		slog.Error("lark invite card action failed", "invite_id", click.InviteID, "open_id", click.OpenID, "error", fmt.Sprintf("%+v", err))
		reply = larkInviteToastReply(larkInviteToastError, larkInviteMsgFailed)
	}

	return reply.encode()
}

// parseLarkInviteClick 解析卡片回调。不是“加入工作区”按钮、载荷无法解析或缺少点击人时 ok 为 false。
func parseLarkInviteClick(payload []byte) (larkInviteClick, bool) {
	var event larkInviteCardActionEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		// 回调字段以飞书实测为准，解析失败说明载荷格式变了，记下来便于排查。
		slog.Warn("decode lark card action failed", "error", err.Error())
		return larkInviteClick{}, false
	}

	e := event.Event
	if e.Action.Value.Action != larkInviteActionJoin || e.Operator.OpenID == "" {
		return larkInviteClick{}, false
	}

	return larkInviteClick{
		InviteID:  e.Action.Value.InviteID,
		OpenID:    e.Operator.OpenID,
		TenantKey: e.Operator.TenantKey,
		MessageID: e.Context.OpenMessageID,
	}, true
}

// answerLarkInviteClick 处理一次点击并给出回应。依次：读邀请和卡片上的名字 → 邀请状态 → 点击人的组织和受邀人
// → 通讯录资料和邮箱 → 找到或新建账号 → 已是成员检查（不占名额）→ 在一个事务里占用名额、写成员和加入记录。
func (h *Handler) answerLarkInviteClick(ctx context.Context, click larkInviteClick) (larkInviteReply, error) {
	if !h.larkInviteEnabled() {
		// 飞书邀请已关闭（未配置开放平台接口，或开启了席位容量），已发出的卡片都不能再用。
		return larkInviteInvalidReply(), nil
	}

	inv, names, err := h.loadLarkInviteForClick(ctx, click.InviteID)
	if errors.Is(err, errLarkInviteGone) {
		// 点击可能被推给了另一个部署，或工作区已删除：只回提示，不改卡片。
		return larkInviteInvalidReply(), nil
	}
	if err != nil {
		return larkInviteReply{}, err
	}

	if reply, done, err := h.larkInviteStatusReply(ctx, inv, names, click); err != nil || done {
		return reply, err
	}

	if !larkTenantAllowed(click.TenantKey) {
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgTenantNotAllowed), nil
	}
	// 群卡片群里的人都能用，其余卡片只有受邀人本人能用。
	if inv.TargetType != larkInviteTargetChat && (!inv.TargetOpenID.Valid || inv.TargetOpenID.String != click.OpenID) {
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgNotInvitee), nil
	}

	profile, err := h.lookupLarkInviteClicker(ctx, click.OpenID)
	if reply, rejected := larkInviteContactRejection(err); rejected {
		logLarkInviteRejection(click, err)
		return reply, nil
	}
	if err != nil {
		return larkInviteReply{}, err
	}

	email := larkInviteUserEmail(profile)
	if email == "" {
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgNoEmail), nil
	}

	user, err := h.larkInviteAccount(ctx, email, click.OpenID, profile)
	var signupErr SignupError
	if errors.As(err, &signupErr) {
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgSignupProhibited), nil
	}
	if errors.Is(err, auth.ErrTemporarilyDisabledUser) {
		logLarkInviteRejection(click, err)
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgAccountDisabled), nil
	}
	if err != nil {
		return larkInviteReply{}, err
	}

	// 已是成员时直接回提示，不占用名额。
	isMember, err := h.larkInviteIsMember(ctx, inv.WorkspaceID, user.ID)
	if err != nil {
		return larkInviteReply{}, err
	}
	if isMember {
		return larkInviteAlreadyMemberReply(names.Workspace), nil
	}

	claimed, err := h.admitLarkInviteMember(ctx, inv, user, click.OpenID)
	switch {
	case errors.Is(err, errAdmitAlreadyMember):
		// 并发点击里另一次先写入了成员，本次占用的名额已随事务回滚。
		return larkInviteAlreadyMemberReply(names.Workspace), nil
	case errors.Is(err, errAdmitClaimRejected):
		return h.larkInviteClaimRejectedReply(ctx, inv, user.ID, names, click)
	case err != nil:
		return larkInviteReply{}, err
	}

	return h.larkInviteJoinedReply(ctx, claimed, names, click), nil
}

// loadLarkInviteForClick 读取被点击的邀请和卡片上的名字。invite_id 不合法、邀请不存在或工作区已删除时
// 返回 errLarkInviteGone。
func (h *Handler) loadLarkInviteForClick(ctx context.Context, inviteID string) (db.LarkInvite, larkInviteCardNames, error) {
	id, err := util.ParseUUID(inviteID)
	if err != nil {
		return db.LarkInvite{}, larkInviteCardNames{}, errLarkInviteGone
	}

	inv, err := h.Queries.GetLarkInvite(ctx, id)
	if isNotFound(err) {
		return db.LarkInvite{}, larkInviteCardNames{}, errLarkInviteGone
	}
	if err != nil {
		return db.LarkInvite{}, larkInviteCardNames{}, errors.Wrapf(err, "get lark invite invite_id=%s", inviteID)
	}

	// 发送人或智能体已删除时名字留空、不报错，这里的 not found 只来自工作区。
	names, err := h.loadLarkInviteCardNames(ctx, inv.WorkspaceID, inv.SentByUserID, inv.SentByAgentID)
	if isNotFound(err) {
		return db.LarkInvite{}, larkInviteCardNames{}, errLarkInviteGone
	}
	if err != nil {
		return db.LarkInvite{}, larkInviteCardNames{}, err
	}

	return inv, names, nil
}

// larkInviteStatusReply 在占用名额之前按邀请状态回应，邀请可用时 done 为 false。名额已满时，通过这张卡片加入过、
// 仍在工作区的人回“你已在 {工作区} 中”：长连接按顺序处理回调，个人卡片连点两下时第二次看到的已是用完的卡片。
func (h *Handler) larkInviteStatusReply(ctx context.Context, inv db.LarkInvite, names larkInviteCardNames, click larkInviteClick) (larkInviteReply, bool, error) {
	now := time.Now()
	if larkInviteStatus(inv, now) == larkInviteStatusCompleted {
		joined, err := h.larkInviteJoinedByClicker(ctx, inv, click.OpenID)
		if err != nil {
			return larkInviteReply{}, false, err
		}
		if joined {
			return larkInviteAlreadyMemberReply(names.Workspace), true, nil
		}
	}

	reply, unavailable := h.larkInviteUnavailableReply(ctx, inv, names, click, now)

	return reply, unavailable, nil
}

// larkInviteUnavailableReply 按邀请状态判断能否加入：撤销或过期时回“邀请已失效”，并在回应之后把卡片改成失效状态；
// 达到人数上限时回“邀请人数已满”。可以加入时 unavailable 为 false。
func (h *Handler) larkInviteUnavailableReply(ctx context.Context, inv db.LarkInvite, names larkInviteCardNames, click larkInviteClick, now time.Time) (reply larkInviteReply, unavailable bool) {
	switch larkInviteStatus(inv, now) {
	case larkInviteStatusRevoked, larkInviteStatusExpired:
		h.patchLarkInviteCardAsync(ctx, inv.ID, larkInviteMessageID(inv, click), names)
		return larkInviteInvalidReply(), true
	case larkInviteStatusCompleted:
		return larkInviteToastReply(larkInviteToastWarning, larkInviteMsgFull), true
	default:
		return larkInviteReply{}, false
	}
}

// larkInviteJoinedByClicker 报告点击人是否已通过这张邀请加入、且仍是工作区成员。只在名额已满时调用，
// 加入记录不超过人数上限。
func (h *Handler) larkInviteJoinedByClicker(ctx context.Context, inv db.LarkInvite, openID string) (bool, error) {
	joins, err := h.Queries.ListLarkInviteJoinsByInviteIDs(ctx, []pgtype.UUID{inv.ID})
	if err != nil {
		return false, errors.Wrapf(err, "list lark invite joins invite_id=%s", uuidToString(inv.ID))
	}

	i := slices.IndexFunc(joins, func(j db.ListLarkInviteJoinsByInviteIDsRow) bool {
		return j.LarkOpenID == openID
	})
	if i < 0 {
		return false, nil
	}

	return h.larkInviteIsMember(ctx, inv.WorkspaceID, joins[i].UserID)
}

// larkInviteClaimRejectedReply 处理事务里名额被拒：并发点击里另一次已经把这个人加进工作区时回“你已在 {工作区} 中”，
// 否则按邀请的最新状态回失效或人数已满。
func (h *Handler) larkInviteClaimRejectedReply(ctx context.Context, inv db.LarkInvite, userID pgtype.UUID, names larkInviteCardNames, click larkInviteClick) (larkInviteReply, error) {
	isMember, err := h.larkInviteIsMember(ctx, inv.WorkspaceID, userID)
	if err != nil {
		return larkInviteReply{}, err
	}
	if isMember {
		return larkInviteAlreadyMemberReply(names.Workspace), nil
	}

	latest, err := h.Queries.GetLarkInvite(ctx, inv.ID)
	if isNotFound(err) {
		return larkInviteInvalidReply(), nil
	}
	if err != nil {
		return larkInviteReply{}, errors.Wrapf(err, "reload lark invite invite_id=%s", uuidToString(inv.ID))
	}

	if reply, unavailable := h.larkInviteUnavailableReply(ctx, latest, names, click, time.Now()); unavailable {
		return reply, nil
	}

	// 数据库按自己的时钟判定已过期，应用时钟下仍算有效：同样按失效处理。
	return larkInviteInvalidReply(), nil
}

// larkInviteJoinedReply 生成加入成功的回应。个人卡片在回应里换成“已加入”状态；群卡片在回应之后异步更新，
// 更新时重新读取邀请，人数和状态都取最新值。
func (h *Handler) larkInviteJoinedReply(ctx context.Context, claimed db.LarkInvite, names larkInviteCardNames, click larkInviteClick) larkInviteReply {
	reply := larkInviteToastReply(larkInviteToastSuccess, fmt.Sprintf(larkInviteMsgJoinedFormat, names.Workspace))

	if claimed.TargetType == larkInviteTargetUser {
		view := h.larkInviteCardViewOf(claimed, names, larkInviteCardJoined)
		reply.Card = &view

		return reply
	}

	h.patchLarkInviteCardAsync(ctx, claimed.ID, larkInviteMessageID(claimed, click), names)

	return reply
}

// lookupLarkInviteClicker 查点击人的通讯录资料，单独限时 larkInviteContactTimeout，超时后仍来得及回应。
func (h *Handler) lookupLarkInviteClicker(ctx context.Context, openID string) (lark.InviteUser, error) {
	lookupCtx, cancel := context.WithTimeout(ctx, larkInviteContactTimeout)
	defer cancel()

	user, err := h.LarkInviteAPI.GetUser(lookupCtx, h.LarkInviteCreds, openID)
	if err != nil {
		return lark.InviteUser{}, errors.Wrapf(err, "get lark user open_id=%s", openID)
	}

	return user, nil
}

// larkInviteContactMessages 是查点击人通讯录资料时确定性的拒绝及其提示，键是 lark.ClassifyInviteError 的错误码。
// 点击人不在应用通讯录范围内（含外部组织成员）时，飞书按错误码归到这两类，重试也不会成功。
var larkInviteContactMessages = map[string]string{
	lark.InviteErrUserNotInScope: larkInviteMsgNotInAppScope,
	lark.InviteErrUserNotFound:   larkInviteMsgUserNotFound,
}

// larkInviteContactRejection 把查通讯录资料的错误归成提示；err 为空或不是确定性的拒绝时 rejected 为 false。
// 飞书应用配置不完整（没开机器人、缺通讯录权限）时点击人看不到有用的信息，回通用的失败提示，
// 具体原因由调用方按 Warn 记录。
func larkInviteContactRejection(err error) (reply larkInviteReply, rejected bool) {
	if _, misconfigured := larkInviteConfigError(err); misconfigured {
		return larkInviteToastReply(larkInviteToastError, larkInviteMsgFailed), true
	}

	msg, ok := larkInviteContactMessages[lark.ClassifyInviteError(err)]
	if !ok {
		return larkInviteReply{}, false
	}

	return larkInviteToastReply(larkInviteToastError, msg), true
}

// logLarkInviteRejection 按 Warn 记录确定性的拒绝：需要管理员调整应用范围、账号或飞书应用配置，不是服务端故障。
func logLarkInviteRejection(click larkInviteClick, err error) {
	slog.Warn("lark invite card action rejected", "invite_id", click.InviteID, "open_id", click.OpenID, "error", err.Error())
}

// larkInviteUserEmail 返回点击人的邮箱，取法与飞书登录一致：优先 email，没有时取 enterprise_email，去掉空白并转小写。
func larkInviteUserEmail(u lark.InviteUser) string {
	return larkUserEmail(&larkUserInfo{Email: u.Email, EnterpriseEmail: u.EnterpriseEmail})
}

// larkInviteAccount 按邮箱找到或新建账号，受现有注册限制约束，被拒时返回的错误可用 errors.As 匹配 SignupError。
// 新账号带上飞书姓名和头像，已有账号不改动。同一个人并发点击时两次都可能去新建账号，
// 邮箱唯一约束冲突的一方改为读取已建好的账号。
func (h *Handler) larkInviteAccount(ctx context.Context, email, openID string, profile lark.InviteUser) (db.User, error) {
	user, isNew, err := h.findOrCreateUser(ctx, email)
	if isUniqueViolation(err) {
		user, isNew, err = h.findOrCreateUser(ctx, email)
	}
	if err != nil {
		return db.User{}, errors.Wrapf(err, "find or create user open_id=%s", openID)
	}
	if !isNew {
		return user, nil
	}

	evt := analytics.Signup(uuidToString(user.ID), user.Email, "")
	evt.Properties["auth_method"] = authMethodLark
	obsmetrics.RecordEvent(h.Analytics, h.Metrics, evt)

	return h.applyLarkInviteProfile(ctx, user, profile)
}

// applyLarkInviteProfile 把飞书姓名和头像写到新建的账号上，飞书没有返回的字段保持原值。
func (h *Handler) applyLarkInviteProfile(ctx context.Context, user db.User, profile lark.InviteUser) (db.User, error) {
	name := strings.TrimSpace(profile.Name)
	if name == "" && profile.AvatarURL == "" {
		return user, nil
	}
	if name == "" {
		name = user.Name
	}

	updated, err := h.Queries.UpdateUser(ctx, db.UpdateUserParams{
		ID:        user.ID,
		Name:      name,
		AvatarUrl: strToText(profile.AvatarURL),
	})
	if err != nil {
		return db.User{}, errors.Wrapf(err, "set lark profile on new user user_id=%s", uuidToString(user.ID))
	}

	return updated, nil
}

// larkInviteIsMember 报告用户是否已是工作区成员。
func (h *Handler) larkInviteIsMember(ctx context.Context, workspaceID, userID pgtype.UUID) (bool, error) {
	_, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		UserID:      userID,
		WorkspaceID: workspaceID,
	})
	if err == nil {
		return true, nil
	}
	if isNotFound(err) {
		return false, nil
	}

	return false, errors.Wrapf(err, "check membership workspace_id=%s user_id=%s", uuidToString(workspaceID), uuidToString(userID))
}

// admitLarkInviteMember 在一个事务里占用一次名额、写成员和加入记录，返回占用名额后的邀请行（use_count 已加一）。
// 这个人以前通过同一张卡片加入过、后来被移出工作区时，加入记录已经存在，唯一约束冲突让整个事务回滚；
// 这时不再写加入记录，重新加入一次。
func (h *Handler) admitLarkInviteMember(ctx context.Context, inv db.LarkInvite, user db.User, openID string) (db.LarkInvite, error) {
	claimed, err := h.admitLarkInviteMemberOnce(ctx, inv, user, openID, true)
	if errors.Is(err, errLarkInviteJoinExists) {
		claimed, err = h.admitLarkInviteMemberOnce(ctx, inv, user, openID, false)
	}

	return claimed, err
}

// admitLarkInviteMemberOnce 执行一次成员写入事务，recordJoin 为 false 时不写加入记录。
// 名额用完、过期或撤销时返回的错误可用 errors.Is 匹配 errAdmitClaimRejected。
func (h *Handler) admitLarkInviteMemberOnce(ctx context.Context, inv db.LarkInvite, user db.User, openID string, recordJoin bool) (db.LarkInvite, error) {
	inviteID := uuidToString(inv.ID)
	var claimed db.LarkInvite

	in := admitMemberInput{
		WorkspaceID: inv.WorkspaceID,
		User:        user,
		Role:        inv.Role,
		// 飞书邀请只在席位容量关闭时可用，不预留席位。
		CapacityToken: uuid.Nil,
		Claim: func(ctx context.Context, qtx *db.Queries) error {
			row, err := qtx.ClaimLarkInviteUse(ctx, inv.ID)
			if isNotFound(err) {
				return errAdmitClaimRejected
			}
			if err != nil {
				return errors.Wrapf(err, "claim lark invite use invite_id=%s", inviteID)
			}
			claimed = row

			return nil
		},
		Source: admitSourceLarkInvite,
	}
	if recordJoin {
		in.AfterCreate = func(ctx context.Context, qtx *db.Queries, _ db.Member) error {
			err := qtx.CreateLarkInviteJoin(ctx, db.CreateLarkInviteJoinParams{
				InviteID:    inv.ID,
				WorkspaceID: inv.WorkspaceID,
				UserID:      user.ID,
				LarkOpenID:  openID,
			})
			if isUniqueViolation(err) {
				return errLarkInviteJoinExists
			}
			if err != nil {
				return errors.Wrapf(err, "create lark invite join invite_id=%s user_id=%s", inviteID, uuidToString(user.ID))
			}

			return nil
		}
	}

	if _, err := h.admitWorkspaceMember(ctx, in); err != nil {
		return db.LarkInvite{}, err
	}

	return claimed, nil
}

// patchLarkInviteCardAsync 在回应之后按邀请的最新状态更新卡片，不占用飞书 3 秒的回应时间。更新不跟随回调的 ctx 取消，
// 单独限时 larkInvitePatchTimeout，失败只记日志。长连接只兜住回调本身的 panic，后台 goroutine 自己恢复。
// 飞书接口、凭据和查询在当前 goroutine 取出，后台 goroutine 不读 Handler 的字段。
func (h *Handler) patchLarkInviteCardAsync(ctx context.Context, inviteID pgtype.UUID, messageID string, names larkInviteCardNames) {
	if messageID == "" {
		return
	}

	patcher := larkInviteCardPatcher{
		api:         h.LarkInviteAPI,
		creds:       h.LarkInviteCreds,
		queries:     h.Queries,
		downloadURL: h.LarkInviteDownloadURL,
	}
	patchCtx := context.WithoutCancel(ctx)

	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("lark invite card patch panicked", "invite_id", uuidToString(inviteID), "recovered", recovered, "stack", string(debug.Stack()))
			}
		}()

		callCtx, cancel := context.WithTimeout(patchCtx, larkInvitePatchTimeout)
		defer cancel()

		if err := patcher.patchLatest(callCtx, inviteID, messageID, names); err != nil {
			slog.Warn("patch lark invite card failed", "invite_id", uuidToString(inviteID), "message_id", messageID, "error", fmt.Sprintf("%+v", err))
		}
	}()
}

// larkInviteCardPatcher 是异步更新卡片用到的依赖，在回调的 goroutine 里从 Handler 取出。
type larkInviteCardPatcher struct {
	api         lark.InviteAPIClient
	creds       lark.InstallationCredentials
	queries     *db.Queries
	downloadURL string
}

// patchLatest 重新读取邀请，按最新状态更新卡片：撤销或过期时改成失效卡片，否则改成邀请中卡片和当前的已加入人数。
// 改成邀请中卡片后再读一次：撤销接口的失效更新可能先一步到达，被这次更新盖掉，这时再改回失效卡片，
// 迟到的更新不会让已撤销的卡片看起来仍然有效。邀请已删除（工作区已删除）时不改卡片。
func (p larkInviteCardPatcher) patchLatest(ctx context.Context, inviteID pgtype.UUID, messageID string, names larkInviteCardNames) error {
	inv, found, err := p.reload(ctx, inviteID)
	if err != nil || !found {
		return err
	}

	view := larkInviteLatestCardView(inv, names, p.downloadURL, time.Now())
	if err := patchLarkInviteCard(ctx, p.api, p.creds, inviteID, messageID, view); err != nil {
		return err
	}
	if view.State == larkInviteCardInvalid {
		return nil
	}

	latest, found, err := p.reload(ctx, inviteID)
	if err != nil || !found {
		return err
	}

	recheck := larkInviteLatestCardView(latest, names, p.downloadURL, time.Now())
	if recheck.State != larkInviteCardInvalid {
		return nil
	}

	return patchLarkInviteCard(ctx, p.api, p.creds, inviteID, messageID, recheck)
}

// reload 读取邀请的最新状态，邀请已不存在时 found 为 false。
func (p larkInviteCardPatcher) reload(ctx context.Context, inviteID pgtype.UUID) (db.LarkInvite, bool, error) {
	inv, err := p.queries.GetLarkInvite(ctx, inviteID)
	if isNotFound(err) {
		return db.LarkInvite{}, false, nil
	}
	if err != nil {
		return db.LarkInvite{}, false, errors.Wrapf(err, "reload lark invite for card patch invite_id=%s", uuidToString(inviteID))
	}

	return inv, true, nil
}

// larkInviteMessageID 返回卡片更新要发往的消息：优先用发送时记下的消息 ID，没有记下时用回调里被点击的消息。
func larkInviteMessageID(inv db.LarkInvite, click larkInviteClick) string {
	if inv.LarkMessageID.Valid && inv.LarkMessageID.String != "" {
		return inv.LarkMessageID.String
	}

	return click.MessageID
}

// larkInviteToastReply 生成只有提示的回应，kind 取 larkInviteToast* 常量。
func larkInviteToastReply(kind, content string) larkInviteReply {
	return larkInviteReply{Kind: kind, Content: content}
}

// larkInviteInvalidReply 生成“邀请已失效”的回应。
func larkInviteInvalidReply() larkInviteReply {
	return larkInviteToastReply(larkInviteToastWarning, larkInviteMsgInvalid)
}

// larkInviteAlreadyMemberReply 生成“你已在 {工作区} 中”的回应。
func larkInviteAlreadyMemberReply(workspace string) larkInviteReply {
	return larkInviteToastReply(larkInviteToastInfo, fmt.Sprintf(larkInviteMsgAlreadyMemberFormat, workspace))
}

// encode 生成回给飞书的 JSON；带替换卡片时卡片无法生成会返回错误。
func (r larkInviteReply) encode() ([]byte, error) {
	if r.Card == nil {
		return buildLarkInviteToast(r.Kind, r.Content), nil
	}

	card, err := buildLarkInviteCard(*r.Card)
	if err != nil {
		return nil, err
	}

	return buildLarkInviteCardResponse(r.Kind, r.Content, card)
}
