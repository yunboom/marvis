package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"
	"golang.org/x/sync/errgroup"

	"github.com/yunboom/marvis/server/internal/integrations/lark"
	"github.com/yunboom/marvis/server/internal/logger"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// 本文件是飞书邀请卡片的 HTTP 接口：发送、列表、详情、撤销、列群、按邮箱查人、
// 是否可用，以及首次进入提示。卡片内容见 lark_invite_card.go。

// 飞书邀请接口返回的错误码，界面和 CLI 按它翻译提示。
const (
	larkInviteCodeNotConfigured    = "lark_not_configured"
	larkInviteCodePermissionDenied = "permission_denied"
	larkInviteCodeInvalidTarget    = "invalid_target"
	// larkInviteCodeInvalidRequest 是接收方以外的参数错误：角色、有效期、人数上限、附言、幂等键、状态筛选。
	larkInviteCodeInvalidRequest = "invalid_request"
	// larkInviteCodeSendFailed 是归不进飞书错误码分类的单个接收方失败。
	larkInviteCodeSendFailed = "send_failed"
	// larkInviteCodeInviteNotFound 表示邀请不存在或不属于该工作区。
	larkInviteCodeInviteNotFound = "invite_not_found"
)

// 邀请状态，按字段推导，不落库；larkInviteStatusAll 只用于列表筛选。
const (
	larkInviteStatusActive    = "active"
	larkInviteStatusCompleted = "completed"
	larkInviteStatusExpired   = "expired"
	larkInviteStatusRevoked   = "revoked"
	larkInviteStatusAll       = "all"
)

// 邀请目标类型，与 lark_invite.target_type 的取值一致。
const (
	larkInviteTargetChat = "chat"
	larkInviteTargetUser = "user"
)

// 邀请目标 ID 类型，与 lark_invite.target_id_type 的取值一致；chat_id、open_id 与飞书 receive_id_type 同源。
const (
	larkInviteIDTypeChatID = string(lark.InviteReceiveChatID)
	larkInviteIDTypeOpenID = string(lark.InviteReceiveOpenID)
	larkInviteIDTypeEmail  = "email"
)

// 飞书 ID 前缀：群 ID 以 oc_ 开头，用户 open_id 以 ou_ 开头。
const (
	larkChatIDPrefix = "oc_"
	larkOpenIDPrefix = "ou_"
)

// 单个接收方的发送结果。
const (
	larkInviteSendStatusSent   = "sent"
	larkInviteSendStatusFailed = "failed"
)

// 卡片链接的组成部分：网页登录页、登录后跳转参数和工作区首页。
const (
	larkInviteLoginPath      = "/login"
	larkInviteLoginNextParam = "next"
	// larkInviteWorkspaceHomeFormat 的参数是工作区 slug，与前端 paths.workspace(slug).issues() 一致。
	larkInviteWorkspaceHomeFormat = "/%s/issues"

	larkInviteSchemeHTTP  = "http"
	larkInviteSchemeHTTPS = "https"
	larkInviteLocalhost   = "localhost"
)

// larkInviteRoleOwner 是工作区所有者角色，只用于权限判断，邀请不能授予这个角色。
const larkInviteRoleOwner = "owner"

// larkInviteActorAgent 是 resolveActor 对智能体请求返回的 actorType。
const larkInviteActorAgent = "agent"

// larkInviteTaskIDHeader 是智能体请求携带任务 ID 的请求头，任务令牌请求由鉴权中间件写入。
const larkInviteTaskIDHeader = "X-Task-ID"

// 发送参数的上下限。
const (
	// larkInviteSendConcurrency 是一次请求里同时向飞书发卡片的接收方数。
	// 飞书没有批量发消息接口，每个接收方都要单独调用；用有上限的并发避免串行等待，也避免瞬间打出过多请求触发限流。
	larkInviteSendConcurrency = 4
	// larkInviteMaxTargets 是一次请求最多的接收方数。
	larkInviteMaxTargets = 50

	larkInviteMinExpiresHours = 1
	larkInviteMaxExpiresHours = 720

	larkInviteNoteMaxRunes           = 200
	larkInviteIdempotencyKeyMaxRunes = 50

	// larkInviteDedupeKeyLen 是传给飞书 uuid 的去重键长度，飞书上限为 50。
	larkInviteDedupeKeyLen = 32

	// larkInviteUserMaxUses 是个人卡片固定的使用次数。
	larkInviteUserMaxUses = 1

	// larkInviteListJoinedLimit 是列表里每条邀请最多带的已加入用户数，详情返回全部。
	larkInviteListJoinedLimit = 5

	// larkInviteSendTimeout 是单次发卡片的超时。发送不跟随请求取消，靠它兜底。
	larkInviteSendTimeout = 15 * time.Second

	// larkInviteReplayWindow 是幂等键的重放窗口，与飞书消息 uuid 的去重窗口（1 小时）一致。
	// 超过窗口，或已有邀请已撤销、过期、用满时，同一个键不再重放，也不再补发。
	larkInviteReplayWindow = time.Hour
)

// 应用配置类错误的说明，管理员需要在飞书开发者后台处理。错误码统一为 larkInviteCodeNotConfigured，说明按原因区分。
const (
	// larkInviteMsgBotNotEnabled 对应飞书 232025：应用没有开启机器人能力。
	larkInviteMsgBotNotEnabled = "the Feishu app's bot ability is not enabled; enable the bot in the Feishu developer console and publish a new version"
	// larkInviteMsgScopeMissing 对应飞书 99991672：应用缺少接口需要的权限范围。
	larkInviteMsgScopeMissing = "the Feishu app is missing a required permission scope; grant im:message:send_as_bot, im:chat:readonly, contact:user.id:readonly, contact:contact.base:readonly, contact:user.base:readonly, contact:user.email:readonly and publish a new version"
)

// larkInviteConfigMessages 是 lark.ClassifyInviteConfigError 的原因对应的英文说明。
var larkInviteConfigMessages = map[string]string{
	lark.InviteConfigBotNotEnabled: larkInviteMsgBotNotEnabled,
	lark.InviteConfigScopeMissing:  larkInviteMsgScopeMissing,
}

// 单个接收方失败时返回的固定说明。
const (
	// larkInviteMsgSendFailed 是非飞书接口错误导致发送失败的说明，细节只记在日志里。
	larkInviteMsgSendFailed = "failed to send the Feishu card"
	// larkInviteMsgFeishuAPIErrorFormat 是归不进分类的飞书接口错误的说明，参数依次是飞书错误码和飞书返回的 msg。
	larkInviteMsgFeishuAPIErrorFormat = "Feishu API error %d: %s"
	// larkInviteMsgFeishuAPIErrorNoMsgFormat 用于飞书没有返回 msg 的情况，参数是飞书错误码。
	larkInviteMsgFeishuAPIErrorNoMsgFormat = "Feishu API error %d"

	// larkInviteMsgKeyNotReplayable 是幂等键命中不可重放的邀请时的说明。
	larkInviteMsgKeyNotReplayable = "idempotency_key was already used for an invite that is no longer replayable; use a new key"
	// larkInviteMsgSendPanicked 是发送这个接收方时发生 panic 的说明，细节只记在日志里。
	larkInviteMsgSendPanicked = "unexpected error while sending the invite"
)

// larkInviteIDNamespace 是从幂等键派生邀请 id 的 UUIDv5 命名空间。取值固定，改动后进行中的重试会拿到不同的 id。
var larkInviteIDNamespace = uuid.MustParse("d4a2c2e7-bdae-47ae-964f-d162526e23eb")

// 失效卡片底部的说明。
const (
	larkInviteReasonRevoked = "已撤销"
	// larkInviteReasonExpiredFormat 的参数是 formatLarkInviteDate 格式化的过期时间。
	larkInviteReasonExpiredFormat = "%s 已过期"
)

// larkInviteErrorMessages 是飞书错误码分类对应的英文说明，随错误码一起返回给界面和 CLI。
var larkInviteErrorMessages = map[string]string{
	lark.InviteErrBotNotInChat:   "the Marvis bot is not in this chat",
	lark.InviteErrUserNotFound:   "user not found in Feishu",
	lark.InviteErrUserNotInScope: "user is outside the availability scope of the Feishu app",
	lark.InviteErrOpenIDCrossApp: "open_id belongs to a different Feishu app; use IDs from the app set as MARVIS_LARK_LOGIN_APP_ID",
}

// SendLarkInvitesRequest 是发送飞书邀请卡片的请求体。界面传群和邮箱，CLI 一次传一个群或 open_id。
type SendLarkInvitesRequest struct {
	ChatIDs     []string `json:"chat_ids"`
	UserOpenIDs []string `json:"user_open_ids"`
	UserEmails  []string `json:"user_emails"`
	Role        string   `json:"role"`
	// ExpiresInHours 是有效期，1 到 720 小时。
	ExpiresInHours int `json:"expires_in_hours"`
	// MaxUses 是群卡片人数上限，0 表示不限；个人卡片固定为 1。
	MaxUses int    `json:"max_uses"`
	Note    string `json:"note"`
	// IdempotencyKey 非空时，同一工作区、同一接收方、同一个键只发一次卡片。
	IdempotencyKey string `json:"idempotency_key"`
}

// LarkInviteTarget 是邀请的接收方。
type LarkInviteTarget struct {
	Type      string  `json:"type"`
	ID        string  `json:"id"`
	IDType    string  `json:"id_type"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
}

// LarkInviteError 是单个接收方的失败原因。
type LarkInviteError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// LarkInviteSendResult 是单个接收方的发送结果，失败时 ID、ExpiresAt、MaxUses 为空。
type LarkInviteSendResult struct {
	ID        *string          `json:"id"`
	Target    LarkInviteTarget `json:"target"`
	Role      string           `json:"role"`
	ExpiresAt *string          `json:"expires_at"`
	MaxUses   *int             `json:"max_uses"`
	Status    string           `json:"status"`
	Error     *LarkInviteError `json:"error"`
}

// LarkInviteActor 是发送邀请的人或代发的智能体。
type LarkInviteActor struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
}

// LarkInviteJoinedUser 是通过邀请卡片加入工作区的人。
type LarkInviteJoinedUser struct {
	UserID    string  `json:"user_id"`
	Name      string  `json:"name"`
	Email     string  `json:"email"`
	AvatarURL *string `json:"avatar_url"`
	JoinedAt  string  `json:"joined_at"`
}

// LarkInviteResponse 是列表、详情、撤销接口返回的一条邀请。
type LarkInviteResponse struct {
	ID          string                 `json:"id"`
	Target      LarkInviteTarget       `json:"target"`
	Role        string                 `json:"role"`
	Status      string                 `json:"status"`
	UseCount    int                    `json:"use_count"`
	MaxUses     *int                   `json:"max_uses"`
	ExpiresAt   string                 `json:"expires_at"`
	RevokedAt   *string                `json:"revoked_at"`
	Note        string                 `json:"note"`
	SentBy      LarkInviteActor        `json:"sent_by"`
	SentByAgent *LarkInviteActor       `json:"sent_by_agent"`
	CreatedAt   string                 `json:"created_at"`
	Joined      []LarkInviteJoinedUser `json:"joined"`
}

// larkInviteSendResponse 是发送接口的响应。
type larkInviteSendResponse struct {
	Results []LarkInviteSendResult `json:"results"`
}

// larkChatResponse 是列群接口返回的一个群。
type larkChatResponse struct {
	ChatID      string  `json:"chat_id"`
	Name        string  `json:"name"`
	AvatarURL   *string `json:"avatar_url"`
	MemberCount int     `json:"member_count"`
}

// larkUserLookupResponse 是按邮箱查到的飞书用户。
type larkUserLookupResponse struct {
	OpenID    string  `json:"open_id"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
	Email     string  `json:"email"`
}

// larkInviteStatusResponse 是飞书邀请是否可用。
type larkInviteStatusResponse struct {
	Enabled bool `json:"enabled"`
}

// larkInviteWelcomeResponse 是首次进入工作区时的提示内容。
type larkInviteWelcomeResponse struct {
	InviteID    string `json:"invite_id"`
	InviterName string `json:"inviter_name"`
	Role        string `json:"role"`
}

// larkInviteSendTarget 是校验后的一个接收方，ID 和 IDType 原样来自请求。
type larkInviteSendTarget struct {
	Type   string
	ID     string
	IDType string
}

// larkInviteSendInput 是校验后的发送参数。
type larkInviteSendInput struct {
	Targets   []larkInviteSendTarget
	Role      string
	ExpiresAt time.Time
	// MaxUses 是群卡片人数上限，0 表示不限。
	MaxUses        int
	Note           string
	IdempotencyKey string
}

// larkInviteSender 是授权发送的人；智能体代发时 AgentID 有效，UserID 为任务发起人。
type larkInviteSender struct {
	UserID  pgtype.UUID
	AgentID pgtype.UUID
}

// larkInviteCardNames 是卡片正文里的工作区名、发送人名和代发智能体名。
type larkInviteCardNames struct {
	Workspace string
	// WorkspaceSlug 用于已加入卡片“打开 Marvis”登录后进入的工作区。
	WorkspaceSlug string
	Inviter       string
	// Agent 在不是智能体代发时为空。
	Agent string
}

// larkInviteSendContext 是一次发送请求里所有接收方共用的数据。
type larkInviteSendContext struct {
	WorkspaceID pgtype.UUID
	Sender      larkInviteSender
	Names       larkInviteCardNames
	Input       larkInviteSendInput
	// LogAttrs 已截断容量，各 goroutine 追加字段时都会分配新数组，不会互相覆盖。
	LogAttrs []any
}

// larkInviteResolvedTarget 是向飞书查到的接收方资料。
type larkInviteResolvedTarget struct {
	ReceiveIDType lark.InviteReceiveIDType
	ReceiveID     string
	// OpenID 是个人卡片的 open_id，群卡片为空。
	OpenID    string
	Name      string
	AvatarURL string
}

// larkInviteEnabled 报告飞书邀请是否可用：配置了开放平台接口，且没有开启席位容量。
func (h *Handler) larkInviteEnabled() bool {
	return h.LarkInviteAPI != nil && !h.seatCapacityEnabled()
}

// requireLarkInviteEnabled 在飞书邀请不可用时写 403 lark_not_configured 并返回 false。
func (h *Handler) requireLarkInviteEnabled(w http.ResponseWriter) bool {
	if h.larkInviteEnabled() {
		return true
	}

	writeFeatureDisabled(w, larkInviteCodeNotConfigured, "feishu invites are not configured on this server")

	return false
}

// requireLarkInviteOriginator 是智能体请求的第二道权限校验，并返回授权发送的人。
// 路由中间件已校验请求人是管理员或所有者；请求来自任务里的智能体时，任务的发起人也必须是
// 该工作区的管理员或所有者，发起人为空时拒绝。普通请求以请求人为发送人。
func (h *Handler) requireLarkInviteOriginator(w http.ResponseWriter, r *http.Request, workspaceID string) (larkInviteSender, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return larkInviteSender{}, false
	}

	userID, ok := requireUserID(w, r)
	if !ok {
		return larkInviteSender{}, false
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	if actorType != larkInviteActorAgent {
		userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")

		return larkInviteSender{UserID: userUUID}, ok
	}

	agentUUID, agentErr := util.ParseUUID(actorID)
	taskUUID, taskErr := util.ParseUUID(r.Header.Get(larkInviteTaskIDHeader))
	if agentErr != nil || taskErr != nil {
		writeLarkInvitePermissionDenied(w)
		return larkInviteSender{}, false
	}

	task, err := h.Queries.GetAgentTask(r.Context(), taskUUID)
	if isNotFound(err) {
		writeLarkInvitePermissionDenied(w)
		return larkInviteSender{}, false
	}
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "get agent task task_id=%s", uuidToString(taskUUID)), "failed to verify task originator")
		return larkInviteSender{}, false
	}

	if task.AgentID != agentUUID || !task.OriginatorUserID.Valid {
		writeLarkInvitePermissionDenied(w)
		return larkInviteSender{}, false
	}

	member, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      task.OriginatorUserID,
		WorkspaceID: workspaceUUID,
	})
	if isNotFound(err) {
		writeLarkInvitePermissionDenied(w)
		return larkInviteSender{}, false
	}
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "get originator member user_id=%s workspace_id=%s", uuidToString(task.OriginatorUserID), workspaceID), "failed to verify task originator")
		return larkInviteSender{}, false
	}

	if !roleAllowed(member.Role, larkInviteRoleOwner, larkInviteRoleAdmin) {
		writeLarkInvitePermissionDenied(w)
		return larkInviteSender{}, false
	}

	return larkInviteSender{UserID: task.OriginatorUserID, AgentID: agentUUID}, true
}

// SendLarkInvites 向群或个人发送飞书邀请卡片，每个接收方独立处理，一个失败不影响其他。
// 请求本身合法时总是返回 200，逐条给出 sent 或 failed。
// POST /api/workspaces/{id}/lark-invites
func (h *Handler) SendLarkInvites(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	workspaceID := workspaceIDFromURL(r, "id")
	sender, ok := h.requireLarkInviteOriginator(w, r, workspaceID)
	if !ok {
		return
	}

	var req SendLarkInvitesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorCode(w, http.StatusBadRequest, larkInviteCodeInvalidRequest, "invalid request body")
		return
	}

	input, verr := parseLarkInviteSendRequest(req, time.Now())
	if verr != nil {
		writeErrorCode(w, http.StatusBadRequest, verr.Code, verr.Message)
		return
	}

	workspaceUUID := parseUUID(workspaceID)
	names, err := h.loadLarkInviteCardNames(r.Context(), workspaceUUID, sender.UserID, sender.AgentID)
	if err != nil {
		writeLarkInviteInternalError(w, r, err, "failed to load invite sender")
		return
	}

	results := h.sendLarkInviteCards(r.Context(), larkInviteSendContext{
		WorkspaceID: workspaceUUID,
		Sender:      sender,
		Names:       names,
		Input:       input,
		LogAttrs:    slices.Clip(logger.RequestAttrs(r)),
	})

	writeJSON(w, http.StatusOK, larkInviteSendResponse{Results: results})
}

// ListLarkInvites 列出工作区的飞书邀请，按创建时间倒序；status 默认 active，all 返回全部。
// 每条邀请最多带 larkInviteListJoinedLimit 个已加入的人。
// GET /api/workspaces/{id}/lark-invites?status=
func (h *Handler) ListLarkInvites(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := h.requireLarkInviteOriginator(w, r, workspaceID); !ok {
		return
	}

	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "" {
		status = larkInviteStatusActive
	}
	if !isLarkInviteStatusFilter(status) {
		writeErrorCode(w, http.StatusBadRequest, larkInviteCodeInvalidRequest, "status must be active, completed, expired, revoked or all")
		return
	}

	workspaceUUID := parseUUID(workspaceID)
	invites, err := h.Queries.ListLarkInvitesByWorkspace(r.Context(), workspaceUUID)
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "list lark invites workspace_id=%s", workspaceID), "failed to list Feishu invites")
		return
	}

	now := time.Now()
	filtered := make([]db.LarkInvite, 0, len(invites))
	for _, inv := range invites {
		if status == larkInviteStatusAll || larkInviteStatus(inv, now) == status {
			filtered = append(filtered, inv)
		}
	}

	resp, err := h.larkInviteResponses(r.Context(), workspaceUUID, filtered, larkInviteListJoinedLimit, now)
	if err != nil {
		writeLarkInviteInternalError(w, r, err, "failed to list Feishu invites")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// GetLarkInvite 返回一条邀请和全部已加入的人。
// GET /api/workspaces/{id}/lark-invites/{inviteId}
func (h *Handler) GetLarkInvite(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := h.requireLarkInviteOriginator(w, r, workspaceID); !ok {
		return
	}

	workspaceUUID := parseUUID(workspaceID)
	inv, ok := h.loadLarkInviteFromURL(w, r, workspaceUUID)
	if !ok {
		return
	}

	h.writeLarkInvite(w, r, inv)
}

// RevokeLarkInvite 撤销一条邀请，再把卡片改成失效状态。卡片更新失败不回滚撤销，只记日志。
// 已撤销的邀请再次撤销时原样返回，不改写撤销时间，也不再更新卡片。
// DELETE /api/workspaces/{id}/lark-invites/{inviteId}
func (h *Handler) RevokeLarkInvite(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := h.requireLarkInviteOriginator(w, r, workspaceID); !ok {
		return
	}

	workspaceUUID := parseUUID(workspaceID)
	inv, ok := h.loadLarkInviteFromURL(w, r, workspaceUUID)
	if !ok {
		return
	}

	if inv.RevokedAt.Valid {
		h.writeLarkInvite(w, r, inv)
		return
	}

	revoked, err := h.Queries.RevokeLarkInvite(r.Context(), db.RevokeLarkInviteParams{ID: inv.ID, WorkspaceID: workspaceUUID})
	if isNotFound(err) {
		// 并发的撤销先一步写入，读回最新状态。
		if inv, ok = h.loadLarkInviteFromURL(w, r, workspaceUUID); ok {
			h.writeLarkInvite(w, r, inv)
		}
		return
	}
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "revoke lark invite invite_id=%s", uuidToString(inv.ID)), "failed to revoke Feishu invite")
		return
	}

	if revoked.LarkMessageID.Valid {
		h.patchRevokedLarkInviteCard(r, revoked)
	}

	h.writeLarkInvite(w, r, revoked)
}

// ListLarkChats 列出 Marvis 机器人所在的飞书群，供界面选择。列群接口不返回人数，member_count 为 0。
// GET /api/workspaces/{id}/lark/chats
func (h *Handler) ListLarkChats(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	if _, ok := h.requireLarkInviteOriginator(w, r, workspaceIDFromURL(r, "id")); !ok {
		return
	}

	chats, err := h.LarkInviteAPI.ListBotChats(r.Context(), h.LarkInviteCreds)
	if err != nil {
		if writeLarkInviteConfigError(w, r, err) {
			return
		}
		writeLarkInviteUpstreamError(w, r, errors.Wrap(err, "list lark bot chats"), "failed to list Feishu chats")
		return
	}

	resp := make([]larkChatResponse, 0, len(chats))
	for _, chat := range chats {
		resp = append(resp, larkChatResponse{
			ChatID:      chat.ChatID,
			Name:        chat.Name,
			AvatarURL:   strPtrOrNil(chat.AvatarURL),
			MemberCount: chat.MemberCount,
		})
	}

	writeJSON(w, http.StatusOK, resp)
}

// LookupLarkUser 按邮箱查飞书用户的 open_id、姓名和头像，界面预览用。查不到时返回 404 和归类后的错误码。
// GET /api/workspaces/{id}/lark/users/lookup?email=
func (h *Handler) LookupLarkUser(w http.ResponseWriter, r *http.Request) {
	if !h.requireLarkInviteEnabled(w) {
		return
	}

	if _, ok := h.requireLarkInviteOriginator(w, r, workspaceIDFromURL(r, "id")); !ok {
		return
	}

	email, ok := canonicalBusinessEmail(r.URL.Query().Get("email"))
	if !ok {
		writeErrorCode(w, http.StatusBadRequest, larkInviteCodeInvalidTarget, "a valid email is required")
		return
	}

	openID, err := h.LarkInviteAPI.LookupOpenIDByEmail(r.Context(), h.LarkInviteCreds, email)
	var user lark.InviteUser
	if err == nil {
		user, err = h.LarkInviteAPI.GetUser(r.Context(), h.LarkInviteCreds, openID)
	}
	if err != nil {
		if writeLarkInviteConfigError(w, r, err) {
			return
		}
		if rejection, ok := larkInviteBusinessError(err); ok {
			writeErrorCode(w, http.StatusNotFound, rejection.Code, rejection.Message)
			return
		}
		writeLarkInviteUpstreamError(w, r, errors.Wrap(err, "lookup lark user by email"), "failed to look up Feishu user")
		return
	}

	writeJSON(w, http.StatusOK, larkUserLookupResponse{
		OpenID:    openID,
		Name:      user.Name,
		AvatarURL: strPtrOrNil(user.AvatarURL),
		Email:     email,
	})
}

// GetLarkInviteStatus 返回飞书邀请是否可用，成员页据此决定显示列表还是未配置提示。所有已登录用户可读。
// GET /api/lark/status
func (h *Handler) GetLarkInviteStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, larkInviteStatusResponse{Enabled: h.larkInviteEnabled()})
}

// GetLarkInviteWelcome 返回当前用户在该工作区还没展示过的首次进入提示，没有时返回 204。
// GET /api/workspaces/{id}/lark-invites/welcome
func (h *Handler) GetLarkInviteWelcome(w http.ResponseWriter, r *http.Request) {
	params, ok := larkInviteWelcomeTarget(w, r)
	if !ok {
		return
	}

	row, err := h.Queries.GetPendingLarkInviteWelcome(r.Context(), db.GetPendingLarkInviteWelcomeParams(params))
	if isNotFound(err) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "get pending lark invite welcome workspace_id=%s", uuidToString(params.WorkspaceID)), "failed to load Feishu invite welcome")
		return
	}

	writeJSON(w, http.StatusOK, larkInviteWelcomeResponse{
		InviteID:    uuidToString(row.InviteID),
		InviterName: row.InviterName,
		Role:        row.Role,
	})
}

// AckLarkInviteWelcome 把当前用户在该工作区的首次进入提示标记为已展示。
// POST /api/workspaces/{id}/lark-invites/welcome/ack
func (h *Handler) AckLarkInviteWelcome(w http.ResponseWriter, r *http.Request) {
	params, ok := larkInviteWelcomeTarget(w, r)
	if !ok {
		return
	}

	if err := h.Queries.MarkLarkInviteWelcomed(r.Context(), params); err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "mark lark invite welcomed workspace_id=%s", uuidToString(params.WorkspaceID)), "failed to acknowledge Feishu invite welcome")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// larkInviteWelcomeTarget 解析首次进入提示的用户和工作区。
func larkInviteWelcomeTarget(w http.ResponseWriter, r *http.Request) (db.MarkLarkInviteWelcomedParams, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace id")
	if !ok {
		return db.MarkLarkInviteWelcomedParams{}, false
	}

	userID, ok := requireUserID(w, r)
	if !ok {
		return db.MarkLarkInviteWelcomedParams{}, false
	}

	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return db.MarkLarkInviteWelcomedParams{}, false
	}

	return db.MarkLarkInviteWelcomedParams{UserID: userUUID, WorkspaceID: workspaceUUID}, true
}

// parseLarkInviteSendRequest 校验发送参数，失败时返回错误码和说明。
func parseLarkInviteSendRequest(req SendLarkInvitesRequest, now time.Time) (larkInviteSendInput, *LarkInviteError) {
	targets, verr := collectLarkInviteTargets(req)
	if verr != nil {
		return larkInviteSendInput{}, verr
	}

	role := strings.ToLower(strings.TrimSpace(req.Role))
	if role == "" {
		role = larkInviteRoleMember
	}
	if role != larkInviteRoleMember && role != larkInviteRoleAdmin {
		return larkInviteSendInput{}, larkInviteInvalidRequest("role must be member or admin")
	}

	if req.ExpiresInHours < larkInviteMinExpiresHours || req.ExpiresInHours > larkInviteMaxExpiresHours {
		return larkInviteSendInput{}, larkInviteInvalidRequest(fmt.Sprintf("expires_in_hours must be between %d and %d", larkInviteMinExpiresHours, larkInviteMaxExpiresHours))
	}

	if req.MaxUses < 0 || req.MaxUses > math.MaxInt32 {
		return larkInviteSendInput{}, larkInviteInvalidRequest("max_uses must be 0 or a positive number")
	}

	note := strings.TrimSpace(req.Note)
	if utf8.RuneCountInString(note) > larkInviteNoteMaxRunes {
		return larkInviteSendInput{}, larkInviteInvalidRequest(fmt.Sprintf("note must be at most %d characters", larkInviteNoteMaxRunes))
	}

	key := strings.TrimSpace(req.IdempotencyKey)
	if utf8.RuneCountInString(key) > larkInviteIdempotencyKeyMaxRunes {
		return larkInviteSendInput{}, larkInviteInvalidRequest(fmt.Sprintf("idempotency_key must be at most %d characters", larkInviteIdempotencyKeyMaxRunes))
	}

	return larkInviteSendInput{
		Targets:        targets,
		Role:           role,
		ExpiresAt:      now.Add(time.Duration(req.ExpiresInHours) * time.Hour),
		MaxUses:        req.MaxUses,
		Note:           note,
		IdempotencyKey: key,
	}, nil
}

// collectLarkInviteTargets 校验并合并请求里的群、open_id、邮箱，按出现顺序去重。
func collectLarkInviteTargets(req SendLarkInvitesRequest) ([]larkInviteSendTarget, *LarkInviteError) {
	targets := make([]larkInviteSendTarget, 0, len(req.ChatIDs)+len(req.UserOpenIDs)+len(req.UserEmails))
	seen := make(map[larkInviteSendTarget]bool)
	add := func(t larkInviteSendTarget) {
		if !seen[t] {
			seen[t] = true
			targets = append(targets, t)
		}
	}

	for _, raw := range req.ChatIDs {
		id := strings.TrimSpace(raw)
		if !isLarkID(id, larkChatIDPrefix) {
			return nil, larkInviteInvalidTarget(fmt.Sprintf("chat_id %q must start with %s", id, larkChatIDPrefix))
		}
		add(larkInviteSendTarget{Type: larkInviteTargetChat, ID: id, IDType: larkInviteIDTypeChatID})
	}

	for _, raw := range req.UserOpenIDs {
		id := strings.TrimSpace(raw)
		if !isLarkID(id, larkOpenIDPrefix) {
			return nil, larkInviteInvalidTarget(fmt.Sprintf("user_open_id %q must start with %s", id, larkOpenIDPrefix))
		}
		add(larkInviteSendTarget{Type: larkInviteTargetUser, ID: id, IDType: larkInviteIDTypeOpenID})
	}

	for _, raw := range req.UserEmails {
		email, ok := canonicalBusinessEmail(raw)
		if !ok {
			return nil, larkInviteInvalidTarget(fmt.Sprintf("user_email %q is not a valid email", strings.TrimSpace(raw)))
		}
		add(larkInviteSendTarget{Type: larkInviteTargetUser, ID: email, IDType: larkInviteIDTypeEmail})
	}

	if len(targets) == 0 {
		return nil, larkInviteInvalidTarget("at least one chat_id, user_open_id or user_email is required")
	}
	if len(targets) > larkInviteMaxTargets {
		return nil, larkInviteInvalidTarget(fmt.Sprintf("at most %d receivers per request", larkInviteMaxTargets))
	}

	return targets, nil
}

// isLarkID 判断 id 以 prefix 开头且前缀之后还有内容。
func isLarkID(id, prefix string) bool {
	return strings.HasPrefix(id, prefix) && len(id) > len(prefix)
}

// larkInviteInvalidTarget 构造接收方参数错误。
func larkInviteInvalidTarget(msg string) *LarkInviteError {
	return &LarkInviteError{Code: larkInviteCodeInvalidTarget, Message: msg}
}

// larkInviteInvalidRequest 构造接收方以外的参数错误。
func larkInviteInvalidRequest(msg string) *LarkInviteError {
	return &LarkInviteError{Code: larkInviteCodeInvalidRequest, Message: msg}
}

// isLarkInviteStatusFilter 判断 status 是不是列表接口接受的筛选值。
func isLarkInviteStatusFilter(status string) bool {
	switch status {
	case larkInviteStatusActive, larkInviteStatusCompleted, larkInviteStatusExpired, larkInviteStatusRevoked, larkInviteStatusAll:
		return true
	default:
		return false
	}
}

// larkInviteStatus 按字段推导邀请状态：撤销优先，其次过期，再次达到人数上限，其余为有效。
func larkInviteStatus(inv db.LarkInvite, now time.Time) string {
	switch {
	case inv.RevokedAt.Valid:
		return larkInviteStatusRevoked
	case !inv.ExpiresAt.Time.After(now):
		return larkInviteStatusExpired
	case inv.MaxUses.Valid && inv.UseCount >= inv.MaxUses.Int32:
		return larkInviteStatusCompleted
	default:
		return larkInviteStatusActive
	}
}

// larkInviteInvalidReason 返回失效卡片底部的说明：撤销时为“已撤销”，过期时为“{M 月 D 日 HH:mm} 已过期”（北京时间），仍有效时为空串。
func larkInviteInvalidReason(inv db.LarkInvite, now time.Time) string {
	if inv.RevokedAt.Valid {
		return larkInviteReasonRevoked
	}
	if !inv.ExpiresAt.Time.After(now) {
		return fmt.Sprintf(larkInviteReasonExpiredFormat, formatLarkInviteDate(inv.ExpiresAt.Time))
	}

	return ""
}

// larkInviteKeyedID 由工作区、幂等键和接收方 ID 派生邀请 id（UUIDv5）：同一请求重试得到同一个 id，
// 已经发出的卡片里的 invite_id 因此始终指向这一行。
func larkInviteKeyedID(workspaceID pgtype.UUID, key, targetID string) pgtype.UUID {
	name := uuidToString(workspaceID) + "\x00" + key + "\x00" + targetID

	return uuidToPG(uuid.NewSHA1(larkInviteIDNamespace, []byte(name)))
}

// larkInviteDedupeKey 由调用方的幂等键和接收方 ID 派生飞书 uuid：同一个键发给不同接收方互不影响，
// 长度固定在飞书 50 字符的上限之内。幂等键为空时返回空串，不做去重。
func larkInviteDedupeKey(idempotencyKey, targetID string) string {
	if idempotencyKey == "" {
		return ""
	}

	sum := sha256.Sum256([]byte(idempotencyKey + "\x00" + targetID))

	return hex.EncodeToString(sum[:])[:larkInviteDedupeKeyLen]
}

// sendLarkInviteCards 向每个接收方发卡片，结果顺序与 sc.Input.Targets 一致。
// 飞书没有批量发消息接口，每个接收方都要单独调用（查资料、写邀请、发卡片各一步，卡片里要带邀请 ID，
// 所以只能先写行再发送）；这里用上限为 larkInviteSendConcurrency 的 goroutine 池并发处理，
// 每个 goroutine 只写自己下标的结果。
func (h *Handler) sendLarkInviteCards(ctx context.Context, sc larkInviteSendContext) []LarkInviteSendResult {
	results := make([]LarkInviteSendResult, len(sc.Input.Targets))

	var g errgroup.Group
	g.SetLimit(larkInviteSendConcurrency)
	for i, target := range sc.Input.Targets {
		g.Go(func() error {
			results[i] = h.sendLarkInviteCardRecovered(ctx, sc, target)
			return nil
		})
	}
	// 每个接收方的错误都已写进各自的结果，Wait 不会返回错误。
	_ = g.Wait()

	return results
}

// sendLarkInviteCardRecovered 调用 sendLarkInviteCard，并把 panic 转成这个接收方的 send_failed 结果。
// 发送池的 goroutine 不在 HTTP 中间件的兜底范围内，panic 会带崩整个进程；堆栈在这里记下。
func (h *Handler) sendLarkInviteCardRecovered(ctx context.Context, sc larkInviteSendContext, target larkInviteSendTarget) (result LarkInviteSendResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("send lark invite panicked", append(sc.LogAttrs, "target_id_type", target.IDType, "recovered", recovered, "stack", string(debug.Stack()))...)
			result = larkInviteRejectedResult(sc, LarkInviteTarget{Type: target.Type, ID: target.ID, IDType: target.IDType},
				&LarkInviteError{Code: larkInviteCodeSendFailed, Message: larkInviteMsgSendPanicked})
		}
	}()

	return h.sendLarkInviteCard(ctx, sc, target)
}

// sendLarkInviteCard 处理一个接收方：带幂等键且已有邀请时按 resumeKeyedLarkInvite 处理；
// 否则查接收方资料、写邀请，再交给 deliverLarkInvite 发卡片。
func (h *Handler) sendLarkInviteCard(ctx context.Context, sc larkInviteSendContext, target larkInviteSendTarget) LarkInviteSendResult {
	shown := LarkInviteTarget{Type: target.Type, ID: target.ID, IDType: target.IDType}
	key := sc.Input.IdempotencyKey

	if key != "" {
		existing, err := h.getKeyedLarkInvite(ctx, sc, target.ID)
		if err == nil {
			return h.resumeKeyedLarkInvite(ctx, sc, existing)
		}
		if !isNotFound(err) {
			return larkInviteFailedResult(sc, shown, errors.Wrapf(err, "get lark invite by idempotency key target_id=%s", target.ID))
		}
	}

	resolved, err := h.resolveLarkInviteTarget(ctx, target)
	if err != nil {
		return larkInviteFailedResult(sc, shown, err)
	}
	shown.Name = resolved.Name
	shown.AvatarURL = strPtrOrNil(resolved.AvatarURL)

	invite, err := h.Queries.CreateLarkInvite(ctx, h.larkInviteCreateParams(sc, target, resolved))
	if err != nil && key != "" && isUniqueViolation(err) {
		// 带同一个幂等键的并发请求先写入了，按已有邀请处理。
		existing, getErr := h.getKeyedLarkInvite(ctx, sc, target.ID)
		if getErr != nil {
			return larkInviteFailedResult(sc, shown, errors.Wrapf(getErr, "get lark invite by idempotency key target_id=%s", target.ID))
		}
		return h.resumeKeyedLarkInvite(ctx, sc, existing)
	}
	if err != nil {
		return larkInviteFailedResult(sc, shown, errors.Wrapf(err, "create lark invite target_id=%s", target.ID))
	}

	return h.deliverLarkInvite(ctx, sc, invite, resolved.ReceiveIDType, resolved.ReceiveID, sc.Names)
}

// getKeyedLarkInvite 按幂等键读取同一接收方的邀请。错误不包装，调用方据此区分没找到，再自行包装。
func (h *Handler) getKeyedLarkInvite(ctx context.Context, sc larkInviteSendContext, targetID string) (db.LarkInvite, error) {
	return h.Queries.GetLarkInviteByIdempotencyKey(ctx, db.GetLarkInviteByIdempotencyKeyParams{
		WorkspaceID:    sc.WorkspaceID,
		TargetID:       targetID,
		IdempotencyKey: strToText(sc.Input.IdempotencyKey),
	})
}

// resumeKeyedLarkInvite 处理幂等键命中的已有邀请。只有邀请仍有效、且创建不到 larkInviteReplayWindow 时才重放：
// 已有消息 ID 时直接返回；还没有消息 ID 时（上次发送结果不明，或并发请求正在发送）用同一个 invite_id 和去重键补发，
// 飞书按去重键保证至多送达一张。其余情况返回 invalid_request、不再发卡片：过了窗口飞书不再按去重键去重，
// 已撤销或已过期的邀请补发出去会是一张看起来有效的卡片。
func (h *Handler) resumeKeyedLarkInvite(ctx context.Context, sc larkInviteSendContext, inv db.LarkInvite) LarkInviteSendResult {
	if !larkInviteReplayable(inv, time.Now()) {
		return larkInviteRejectedResult(sc, larkInviteTargetOf(inv), larkInviteInvalidRequest(larkInviteMsgKeyNotReplayable))
	}

	if inv.LarkMessageID.Valid {
		return larkInviteSentResult(inv)
	}

	idType, receiveID := larkInviteReceiver(inv)
	if receiveID == "" {
		return larkInviteFailedResult(sc, larkInviteTargetOf(inv), errors.Errorf("lark invite has no receiver invite_id=%s", uuidToString(inv.ID)))
	}

	names, err := h.larkInviteNamesFor(ctx, sc, inv)
	if err != nil {
		return larkInviteFailedResult(sc, larkInviteTargetOf(inv), err)
	}

	return h.deliverLarkInvite(ctx, sc, inv, idType, receiveID, names)
}

// larkInviteReplayable 报告带幂等键的已有邀请能否重放：仍有效（未撤销、未过期、未用满），且创建不到 larkInviteReplayWindow。
func larkInviteReplayable(inv db.LarkInvite, now time.Time) bool {
	return larkInviteStatus(inv, now) == larkInviteStatusActive && now.Sub(inv.CreatedAt.Time) < larkInviteReplayWindow
}

// larkInviteReceiver 返回邀请卡片的接收方：群卡片发到群，个人卡片发到写入时解析出的 open_id。
func larkInviteReceiver(inv db.LarkInvite) (lark.InviteReceiveIDType, string) {
	if inv.TargetType == larkInviteTargetChat {
		return lark.InviteReceiveChatID, inv.TargetID
	}

	return lark.InviteReceiveOpenID, inv.TargetOpenID.String
}

// larkInviteNamesFor 返回卡片上要显示的名字：邀请的发送人与本次请求相同时复用已读取的名字，否则按邀请记录读取。
func (h *Handler) larkInviteNamesFor(ctx context.Context, sc larkInviteSendContext, inv db.LarkInvite) (larkInviteCardNames, error) {
	if inv.SentByUserID == sc.Sender.UserID && inv.SentByAgentID == sc.Sender.AgentID {
		return sc.Names, nil
	}

	return h.loadLarkInviteCardNames(ctx, inv.WorkspaceID, inv.SentByUserID, inv.SentByAgentID)
}

// deliverLarkInvite 生成邀请中状态的卡片发给接收方，并记下消息 ID。
// 发送失败时：没有幂等键，或飞书明确拒绝（归进业务错误码或应用配置类错误）时删除这条邀请；有幂等键而失败原因不明
// （超时、网络、5xx）时保留，卡片可能其实已经送达，重试时用同一个 invite_id 和去重键补发。
func (h *Handler) deliverLarkInvite(ctx context.Context, sc larkInviteSendContext, inv db.LarkInvite, idType lark.InviteReceiveIDType, receiveID string, names larkInviteCardNames) LarkInviteSendResult {
	shown := larkInviteTargetOf(inv)

	card, err := buildLarkInviteCard(h.larkInviteCardViewOf(inv, names, larkInviteCardActive))
	if err != nil {
		h.deleteUnsentLarkInvite(ctx, sc, inv.ID)
		return larkInviteFailedResult(sc, shown, err)
	}

	messageID, err := h.sendLarkInviteMessage(ctx, sc, inv, idType, receiveID, card)
	if err != nil {
		_, classified := classifyLarkInviteError(err)
		if sc.Input.IdempotencyKey == "" || classified {
			h.deleteUnsentLarkInvite(ctx, sc, inv.ID)
		}

		return larkInviteFailedResult(sc, shown, err)
	}

	// 卡片已经发出，消息 ID 必须记下，不跟随请求取消。
	if err := h.Queries.SetLarkInviteMessageID(context.WithoutCancel(ctx), db.SetLarkInviteMessageIDParams{ID: inv.ID, LarkMessageID: strToText(messageID)}); err != nil {
		// 返回失败会让调用方重试，这里只记日志；有幂等键时重试会按去重键补发，不会多出一张卡片。
		err = errors.Wrapf(err, "set lark invite message id invite_id=%s", uuidToString(inv.ID))
		slog.Error("store lark invite message id failed", append(sc.LogAttrs, "error", fmt.Sprintf("%+v", err))...)
	}

	return larkInviteSentResult(inv)
}

// sendLarkInviteMessage 调飞书发卡片。发送不跟随请求取消、单独限时 larkInviteSendTimeout：
// 客户端断开时正在进行的发送照常完成，不会把已送达的卡片当成失败处理。
func (h *Handler) sendLarkInviteMessage(ctx context.Context, sc larkInviteSendContext, inv db.LarkInvite, idType lark.InviteReceiveIDType, receiveID, card string) (string, error) {
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), larkInviteSendTimeout)
	defer cancel()

	dedupeKey := larkInviteDedupeKey(sc.Input.IdempotencyKey, inv.TargetID)
	messageID, err := h.LarkInviteAPI.SendInviteCard(sendCtx, h.LarkInviteCreds, idType, receiveID, card, dedupeKey)
	if err != nil {
		return "", errors.Wrapf(err, "send lark invite card invite_id=%s", uuidToString(inv.ID))
	}

	return messageID, nil
}

// resolveLarkInviteTarget 向飞书查接收方资料：群查群名和头像；个人先把邮箱换成 open_id，再查姓名和头像。
func (h *Handler) resolveLarkInviteTarget(ctx context.Context, target larkInviteSendTarget) (larkInviteResolvedTarget, error) {
	switch target.IDType {
	case larkInviteIDTypeChatID:
		chat, err := h.LarkInviteAPI.GetChat(ctx, h.LarkInviteCreds, target.ID)
		if err != nil {
			return larkInviteResolvedTarget{}, errors.Wrapf(err, "resolve lark invite chat chat_id=%s", target.ID)
		}

		return larkInviteResolvedTarget{
			ReceiveIDType: lark.InviteReceiveChatID,
			ReceiveID:     target.ID,
			Name:          chat.Name,
			AvatarURL:     chat.AvatarURL,
		}, nil
	case larkInviteIDTypeOpenID:
		return h.resolveLarkInviteUser(ctx, target.ID)
	case larkInviteIDTypeEmail:
		// 错误里不带邮箱，避免个人信息进入日志。
		openID, err := h.LarkInviteAPI.LookupOpenIDByEmail(ctx, h.LarkInviteCreds, target.ID)
		if err != nil {
			return larkInviteResolvedTarget{}, errors.Wrap(err, "resolve lark invite user by email")
		}

		return h.resolveLarkInviteUser(ctx, openID)
	default:
		return larkInviteResolvedTarget{}, errors.Errorf("unknown lark invite target id type %q", target.IDType)
	}
}

// resolveLarkInviteUser 按 open_id 查用户姓名和头像，个人卡片发给这个 open_id。
func (h *Handler) resolveLarkInviteUser(ctx context.Context, openID string) (larkInviteResolvedTarget, error) {
	user, err := h.LarkInviteAPI.GetUser(ctx, h.LarkInviteCreds, openID)
	if err != nil {
		return larkInviteResolvedTarget{}, errors.Wrapf(err, "resolve lark invite user open_id=%s", openID)
	}

	return larkInviteResolvedTarget{
		ReceiveIDType: lark.InviteReceiveOpenID,
		ReceiveID:     openID,
		OpenID:        openID,
		Name:          user.Name,
		AvatarURL:     user.AvatarURL,
	}, nil
}

// larkInviteCreateParams 组装写入 lark_invite 的参数：群卡片按请求设人数上限，个人卡片固定为 1；
// 带幂等键时邀请 id 由幂等键派生，不带时由数据库生成。
func (h *Handler) larkInviteCreateParams(sc larkInviteSendContext, target larkInviteSendTarget, resolved larkInviteResolvedTarget) db.CreateLarkInviteParams {
	var maxUses pgtype.Int4
	switch {
	case target.Type == larkInviteTargetUser:
		maxUses = pgtype.Int4{Int32: larkInviteUserMaxUses, Valid: true}
	case sc.Input.MaxUses > 0:
		maxUses = pgtype.Int4{Int32: int32(sc.Input.MaxUses), Valid: true}
	}

	params := db.CreateLarkInviteParams{
		WorkspaceID:     sc.WorkspaceID,
		TargetType:      target.Type,
		TargetID:        target.ID,
		TargetIDType:    target.IDType,
		TargetOpenID:    strToText(resolved.OpenID),
		TargetName:      resolved.Name,
		TargetAvatarUrl: strToText(resolved.AvatarURL),
		Role:            sc.Input.Role,
		MaxUses:         maxUses,
		ExpiresAt:       pgtype.Timestamptz{Time: sc.Input.ExpiresAt, Valid: true},
		Note:            sc.Input.Note,
		IdempotencyKey:  strToText(sc.Input.IdempotencyKey),
		SentByUserID:    sc.Sender.UserID,
		SentByAgentID:   sc.Sender.AgentID,
	}
	if sc.Input.IdempotencyKey != "" {
		params.ID = larkInviteKeyedID(sc.WorkspaceID, sc.Input.IdempotencyKey, target.ID)
	}

	return params
}

// deleteUnsentLarkInvite 删除没发出去的邀请。请求可能已经结束，删除不跟随请求取消；删除失败只记日志，
// 残留的行没有对应卡片，没有人能点击。
func (h *Handler) deleteUnsentLarkInvite(ctx context.Context, sc larkInviteSendContext, inviteID pgtype.UUID) {
	if err := h.Queries.DeleteLarkInvite(context.WithoutCancel(ctx), inviteID); err != nil {
		err = errors.Wrapf(err, "delete unsent lark invite invite_id=%s", uuidToString(inviteID))
		slog.Error("delete unsent lark invite failed", append(sc.LogAttrs, "error", fmt.Sprintf("%+v", err))...)
	}
}

// larkInviteCardViewOf 由邀请行和名字构造卡片数据；群卡片带已加入人数。
func (h *Handler) larkInviteCardViewOf(inv db.LarkInvite, names larkInviteCardNames, state larkInviteCardState) larkInviteCardView {
	return newLarkInviteCardView(inv, names, state, h.larkInviteCardLinks(names))
}

// larkInviteCardLinks 返回卡片上的链接：首页和登录页取网页地址（larkInviteAppURL），下载取桌面端下载地址。
func (h *Handler) larkInviteCardLinks(names larkInviteCardNames) larkInviteCardLinks {
	return newLarkInviteCardLinks(h.cfg.AppURL, h.LarkInviteDownloadURL, names.WorkspaceSlug)
}

// newLarkInviteCardLinks 由网页地址、下载地址和工作区 slug 生成卡片链接。网页地址不可用时首页和登录页留空。
func newLarkInviteCardLinks(appURL, downloadURL, workspaceSlug string) larkInviteCardLinks {
	links := larkInviteCardLinks{Download: downloadURL}

	app := larkInviteAppURL(appURL)
	if app == "" {
		return links
	}

	links.Landing = app
	if workspaceSlug != "" {
		next := url.Values{larkInviteLoginNextParam: {fmt.Sprintf(larkInviteWorkspaceHomeFormat, url.PathEscape(workspaceSlug))}}
		links.Login = app + larkInviteLoginPath + "?" + next.Encode()
	}

	return links
}

// larkInviteAppURL 校验卡片链接用的网页地址（MARVIS_APP_URL，未设置时为 FRONTEND_ORIGIN；按路径前缀部署时含前缀），
// 返回去掉末尾斜杠的地址。没配置、不是 http(s) 或指向本机时返回空串：卡片在受邀人的飞书里打开，本机地址点不开。
func larkInviteAppURL(raw string) string {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != larkInviteSchemeHTTP && u.Scheme != larkInviteSchemeHTTPS) {
		return ""
	}

	host := u.Hostname()
	if strings.EqualFold(host, larkInviteLocalhost) {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return ""
	}

	return raw
}

// newLarkInviteCardView 由邀请行、名字和链接构造卡片数据；群卡片带人数上限和已加入人数。
func newLarkInviteCardView(inv db.LarkInvite, names larkInviteCardNames, state larkInviteCardState, links larkInviteCardLinks) larkInviteCardView {
	view := larkInviteCardView{
		State:         state,
		InviteID:      uuidToString(inv.ID),
		WorkspaceName: names.Workspace,
		InviterName:   names.Inviter,
		AgentName:     names.Agent,
		Role:          inv.Role,
		Note:          inv.Note,
		ExpiresAt:     inv.ExpiresAt.Time,
		Links:         links,
	}
	if inv.TargetType == larkInviteTargetChat {
		view.IsGroup = true
		view.JoinedCount = int(inv.UseCount)
		if inv.MaxUses.Valid {
			view.MaxUses = int(inv.MaxUses.Int32)
		}
	}

	return view
}

// larkInviteInvalidCardView 构造失效状态的卡片数据，底部说明按撤销或过期生成。
func (h *Handler) larkInviteInvalidCardView(inv db.LarkInvite, names larkInviteCardNames, now time.Time) larkInviteCardView {
	return newLarkInviteInvalidCardView(inv, names, h.larkInviteCardLinks(names), now)
}

// newLarkInviteInvalidCardView 构造失效状态的卡片数据，状态文字和底部说明按撤销或过期生成。
func newLarkInviteInvalidCardView(inv db.LarkInvite, names larkInviteCardNames, links larkInviteCardLinks, now time.Time) larkInviteCardView {
	view := newLarkInviteCardView(inv, names, larkInviteCardInvalid, links)
	view.InvalidReason = larkInviteInvalidReason(inv, now)
	if status := larkInviteStatus(inv, now); status == larkInviteStatusRevoked || status == larkInviteStatusExpired {
		view.InvalidStatus = status
	}

	return view
}

// larkInviteLatestCardView 按邀请的当前状态构造群卡片数据：撤销或过期时为失效卡片，否则为邀请中卡片。
func larkInviteLatestCardView(inv db.LarkInvite, names larkInviteCardNames, links larkInviteCardLinks, now time.Time) larkInviteCardView {
	switch larkInviteStatus(inv, now) {
	case larkInviteStatusRevoked, larkInviteStatusExpired:
		return newLarkInviteInvalidCardView(inv, names, links, now)
	default:
		return newLarkInviteCardView(inv, names, larkInviteCardActive, links)
	}
}

// patchRevokedLarkInviteCard 把刚撤销的邀请卡片改成失效状态。撤销已经写入，卡片更新不跟随请求取消、单独限时
// larkInvitePatchTimeout：客户端断开时卡片照样改成失效。更新失败不回滚撤销，只记日志。
func (h *Handler) patchRevokedLarkInviteCard(r *http.Request, revoked db.LarkInvite) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), larkInvitePatchTimeout)
	defer cancel()

	if err := h.patchLarkInviteInvalidCard(ctx, revoked, time.Now()); err != nil {
		slog.Warn("patch revoked lark invite card failed", append(logger.RequestAttrs(r), "invite_id", uuidToString(revoked.ID), "error", fmt.Sprintf("%+v", err))...)
	}
}

// patchLarkInviteInvalidCard 把邀请卡片更新为失效状态，底部说明按撤销或过期生成。
func (h *Handler) patchLarkInviteInvalidCard(ctx context.Context, inv db.LarkInvite, now time.Time) error {
	names, err := h.loadLarkInviteCardNames(ctx, inv.WorkspaceID, inv.SentByUserID, inv.SentByAgentID)
	if err != nil {
		return err
	}

	return patchLarkInviteCard(ctx, h.LarkInviteAPI, h.LarkInviteCreds, inv.ID, inv.LarkMessageID.String, h.larkInviteInvalidCardView(inv, names, now))
}

// patchLarkInviteCard 按 view 生成卡片，更新 messageID 这条消息。接口和凭据由调用方传入，
// 后台 goroutine 调用时不必再读 Handler 的字段。
func patchLarkInviteCard(ctx context.Context, api lark.InviteAPIClient, creds lark.InstallationCredentials, inviteID pgtype.UUID, messageID string, view larkInviteCardView) error {
	card, err := buildLarkInviteCard(view)
	if err != nil {
		return err
	}

	if err := api.PatchInviteCard(ctx, creds, messageID, card); err != nil {
		return errors.Wrapf(err, "patch lark invite card invite_id=%s", uuidToString(inviteID))
	}

	return nil
}

// loadLarkInviteCardNames 读取卡片正文需要的工作区名、发送人名和代发智能体名；用户或智能体已删除时对应名字留空。
func (h *Handler) loadLarkInviteCardNames(ctx context.Context, workspaceID, userID, agentID pgtype.UUID) (larkInviteCardNames, error) {
	ws, err := h.Queries.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return larkInviteCardNames{}, errors.Wrapf(err, "get workspace workspace_id=%s", uuidToString(workspaceID))
	}
	names := larkInviteCardNames{Workspace: ws.Name, WorkspaceSlug: ws.Slug}

	user, err := h.Queries.GetUser(ctx, userID)
	switch {
	case err == nil:
		names.Inviter = user.Name
	case !isNotFound(err):
		return larkInviteCardNames{}, errors.Wrapf(err, "get user user_id=%s", uuidToString(userID))
	}

	if !agentID.Valid {
		return names, nil
	}

	agent, err := h.Queries.GetAgent(ctx, agentID)
	switch {
	case err == nil:
		names.Agent = agent.Name
	case !isNotFound(err):
		return larkInviteCardNames{}, errors.Wrapf(err, "get agent agent_id=%s", uuidToString(agentID))
	}

	return names, nil
}

// loadLarkInviteFromURL 按 URL 里的 inviteId 读取本工作区的邀请，不存在时写 404 并返回 false。
func (h *Handler) loadLarkInviteFromURL(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID) (db.LarkInvite, bool) {
	inviteUUID, err := util.ParseUUID(chi.URLParam(r, "inviteId"))
	if err != nil {
		writeErrorCode(w, http.StatusBadRequest, larkInviteCodeInvalidRequest, "invalid invite id")
		return db.LarkInvite{}, false
	}

	inv, err := h.Queries.GetLarkInviteInWorkspace(r.Context(), db.GetLarkInviteInWorkspaceParams{ID: inviteUUID, WorkspaceID: workspaceID})
	if isNotFound(err) {
		writeErrorCode(w, http.StatusNotFound, larkInviteCodeInviteNotFound, "invite not found")
		return db.LarkInvite{}, false
	}
	if err != nil {
		writeLarkInviteInternalError(w, r, errors.Wrapf(err, "get lark invite invite_id=%s", uuidToString(inviteUUID)), "failed to load Feishu invite")
		return db.LarkInvite{}, false
	}

	return inv, true
}

// writeLarkInvite 返回一条邀请和全部已加入的人。
func (h *Handler) writeLarkInvite(w http.ResponseWriter, r *http.Request, inv db.LarkInvite) {
	resp, err := h.larkInviteResponses(r.Context(), inv.WorkspaceID, []db.LarkInvite{inv}, 0, time.Now())
	if err != nil {
		writeLarkInviteInternalError(w, r, err, "failed to load Feishu invite")
		return
	}

	writeJSON(w, http.StatusOK, resp[0])
}

// larkInviteResponses 把邀请行转成响应。已加入的人、发送人、代发智能体各用一次批量查询取回，不逐条查询。
// joinedLimit 为 0 时返回全部已加入的人。
func (h *Handler) larkInviteResponses(ctx context.Context, workspaceID pgtype.UUID, invites []db.LarkInvite, joinedLimit int, now time.Time) ([]LarkInviteResponse, error) {
	resp := make([]LarkInviteResponse, 0, len(invites))
	if len(invites) == 0 {
		return resp, nil
	}

	inviteIDs := make([]pgtype.UUID, 0, len(invites))
	userIDs := make([]pgtype.UUID, 0, len(invites))
	seenUsers := make(map[pgtype.UUID]bool, len(invites))
	hasAgent := false
	for _, inv := range invites {
		inviteIDs = append(inviteIDs, inv.ID)
		if !seenUsers[inv.SentByUserID] {
			seenUsers[inv.SentByUserID] = true
			userIDs = append(userIDs, inv.SentByUserID)
		}
		hasAgent = hasAgent || inv.SentByAgentID.Valid
	}

	joins, err := h.Queries.ListLarkInviteJoinsByInviteIDs(ctx, inviteIDs)
	if err != nil {
		return nil, errors.Wrapf(err, "list lark invite joins workspace_id=%s", uuidToString(workspaceID))
	}
	joinedByInvite := make(map[pgtype.UUID][]LarkInviteJoinedUser, len(invites))
	for _, j := range joins {
		joined := joinedByInvite[j.InviteID]
		if joinedLimit > 0 && len(joined) >= joinedLimit {
			continue
		}
		joinedByInvite[j.InviteID] = append(joined, LarkInviteJoinedUser{
			UserID:    uuidToString(j.UserID),
			Name:      j.UserName,
			Email:     j.UserEmail,
			AvatarURL: textToPtr(j.UserAvatarUrl),
			JoinedAt:  timestampToString(j.JoinedAt),
		})
	}

	users, err := h.Queries.GetUsersByIDs(ctx, userIDs)
	if err != nil {
		return nil, errors.Wrapf(err, "get lark invite senders workspace_id=%s", uuidToString(workspaceID))
	}
	usersByID := make(map[pgtype.UUID]db.GetUsersByIDsRow, len(users))
	for _, u := range users {
		usersByID[u.ID] = u
	}

	agentsByID := map[pgtype.UUID]db.Agent{}
	if hasAgent {
		// 一次取回工作区的全部智能体（含已归档），代发邀请的智能体从中查名字。
		agents, err := h.Queries.ListAllAgents(ctx, workspaceID)
		if err != nil {
			return nil, errors.Wrapf(err, "list lark invite agents workspace_id=%s", uuidToString(workspaceID))
		}
		for _, a := range agents {
			agentsByID[a.ID] = a
		}
	}

	for _, inv := range invites {
		resp = append(resp, larkInviteResponseOf(inv, usersByID, agentsByID, joinedByInvite[inv.ID], now))
	}

	return resp, nil
}

// larkInviteResponseOf 组装一条邀请的响应；发送人或智能体已删除时只返回 ID。
func larkInviteResponseOf(inv db.LarkInvite, users map[pgtype.UUID]db.GetUsersByIDsRow, agents map[pgtype.UUID]db.Agent, joined []LarkInviteJoinedUser, now time.Time) LarkInviteResponse {
	sentBy := LarkInviteActor{ID: uuidToString(inv.SentByUserID)}
	if u, ok := users[inv.SentByUserID]; ok {
		sentBy.Name = u.Name
		sentBy.AvatarURL = textToPtr(u.AvatarUrl)
	}

	var sentByAgent *LarkInviteActor
	if inv.SentByAgentID.Valid {
		actor := LarkInviteActor{ID: uuidToString(inv.SentByAgentID)}
		if a, ok := agents[inv.SentByAgentID]; ok {
			actor.Name = a.Name
			actor.AvatarURL = textToPtr(a.AvatarUrl)
		}
		sentByAgent = &actor
	}

	if joined == nil {
		joined = []LarkInviteJoinedUser{}
	}

	return LarkInviteResponse{
		ID:          uuidToString(inv.ID),
		Target:      larkInviteTargetOf(inv),
		Role:        inv.Role,
		Status:      larkInviteStatus(inv, now),
		UseCount:    int(inv.UseCount),
		MaxUses:     larkInviteMaxUsesPtr(inv.MaxUses),
		ExpiresAt:   timestampToString(inv.ExpiresAt),
		RevokedAt:   timestampToPtr(inv.RevokedAt),
		Note:        inv.Note,
		SentBy:      sentBy,
		SentByAgent: sentByAgent,
		CreatedAt:   timestampToString(inv.CreatedAt),
		Joined:      joined,
	}
}

// larkInviteTargetOf 从邀请行取出接收方。
func larkInviteTargetOf(inv db.LarkInvite) LarkInviteTarget {
	return LarkInviteTarget{
		Type:      inv.TargetType,
		ID:        inv.TargetID,
		IDType:    inv.TargetIDType,
		Name:      inv.TargetName,
		AvatarURL: textToPtr(inv.TargetAvatarUrl),
	}
}

// larkInviteMaxUsesPtr 把可空的人数上限转成指针，空表示不限。
func larkInviteMaxUsesPtr(v pgtype.Int4) *int {
	if !v.Valid {
		return nil
	}
	n := int(v.Int32)

	return &n
}

// larkInviteSentResult 把邀请行转成发送成功的结果。
func larkInviteSentResult(inv db.LarkInvite) LarkInviteSendResult {
	return LarkInviteSendResult{
		ID:        uuidToPtr(inv.ID),
		Target:    larkInviteTargetOf(inv),
		Role:      inv.Role,
		ExpiresAt: timestampToPtr(inv.ExpiresAt),
		MaxUses:   larkInviteMaxUsesPtr(inv.MaxUses),
		Status:    larkInviteSendStatusSent,
	}
}

// larkInviteBusinessError 把飞书错误归进 lark.ClassifyInviteError 的四类（机器人不在群、找不到用户等），
// 返回对应的错误码和固定说明；归不进时 ok 为 false。
func larkInviteBusinessError(err error) (rejection LarkInviteError, ok bool) {
	code := lark.ClassifyInviteError(err)
	if code == "" {
		return LarkInviteError{}, false
	}

	return LarkInviteError{Code: code, Message: larkInviteErrorMessages[code]}, true
}

// larkInviteConfigError 把飞书错误归进应用配置类错误（没开机器人、缺权限范围）。
// 错误码统一为 lark_not_configured，说明按原因区分；归不进时 ok 为 false。
func larkInviteConfigError(err error) (rejection LarkInviteError, ok bool) {
	cause := lark.ClassifyInviteConfigError(err)
	if cause == "" {
		return LarkInviteError{}, false
	}

	return LarkInviteError{Code: larkInviteCodeNotConfigured, Message: larkInviteConfigMessages[cause]}, true
}

// classifyLarkInviteError 把飞书错误归成对外的错误码和说明，先看应用配置类，再看业务类；都不是时 ok 为 false。
func classifyLarkInviteError(err error) (rejection LarkInviteError, ok bool) {
	if rejection, ok = larkInviteConfigError(err); ok {
		return rejection, true
	}

	return larkInviteBusinessError(err)
}

// larkInviteUnclassifiedMessage 返回归不进分类的发送错误对外的说明：飞书接口错误只带错误码和飞书返回的 msg
// （不含排查链接和 log_id），其余错误用固定文案。完整错误只记在日志里。
func larkInviteUnclassifiedMessage(err error) string {
	code, msg, ok := lark.InviteAPIErrorDetail(err)
	switch {
	case !ok:
		return larkInviteMsgSendFailed
	case msg == "":
		return fmt.Sprintf(larkInviteMsgFeishuAPIErrorNoMsgFormat, code)
	default:
		return fmt.Sprintf(larkInviteMsgFeishuAPIErrorFormat, code, msg)
	}
}

// larkInviteFailedResult 把单个接收方的错误转成失败结果。应用配置类错误返回 lark_not_configured 和对应说明，
// 并按 Warn 记录日志；归进飞书错误码分类的返回固定说明；其余的返回 send_failed 和 larkInviteUnclassifiedMessage，
// 并记录带堆栈的日志。
func larkInviteFailedResult(sc larkInviteSendContext, target LarkInviteTarget, err error) LarkInviteSendResult {
	rejection, classified := classifyLarkInviteError(err)
	switch {
	case !classified:
		rejection = LarkInviteError{Code: larkInviteCodeSendFailed, Message: larkInviteUnclassifiedMessage(err)}
		slog.Warn("send lark invite failed", append(sc.LogAttrs, "target_id_type", target.IDType, "error", fmt.Sprintf("%+v", err))...)
	case rejection.Code == larkInviteCodeNotConfigured:
		slog.Warn("send lark invite failed: feishu app is not configured", append(sc.LogAttrs, "target_id_type", target.IDType, "error", fmt.Sprintf("%+v", err))...)
	}

	return LarkInviteSendResult{
		Target: target,
		Role:   sc.Input.Role,
		Status: larkInviteSendStatusFailed,
		Error:  &rejection,
	}
}

// larkInviteRejectedResult 把可预期的单个接收方拒绝（参数类错误）转成失败结果，不记日志。
func larkInviteRejectedResult(sc larkInviteSendContext, target LarkInviteTarget, rejection *LarkInviteError) LarkInviteSendResult {
	return LarkInviteSendResult{
		Target: target,
		Role:   sc.Input.Role,
		Status: larkInviteSendStatusFailed,
		Error:  rejection,
	}
}

// writeLarkInvitePermissionDenied 写 403 permission_denied。
func writeLarkInvitePermissionDenied(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusForbidden, larkInviteCodePermissionDenied, "the task originator must be an owner or admin of this workspace")
}

// writeLarkInviteInternalError 记录无法处理的错误（带堆栈）并返回 500。HTTP 处理函数是最上层，错误在这里统一打印。
func writeLarkInviteInternalError(w http.ResponseWriter, r *http.Request, err error, msg string) {
	slog.Error(msg, append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", err))...)
	writeError(w, http.StatusInternalServerError, msg)
}

// writeLarkInviteConfigError 在飞书错误是应用配置类错误（没开机器人、缺权限范围）时按 Warn 记录并写
// 403 lark_not_configured，与开关关闭同一个状态码；返回是否已处理。需要管理员调整飞书应用，不是服务端故障，不返回 502。
func writeLarkInviteConfigError(w http.ResponseWriter, r *http.Request, err error) bool {
	rejection, ok := larkInviteConfigError(err)
	if !ok {
		return false
	}

	slog.Warn("feishu app is not configured for invites", append(logger.RequestAttrs(r), "reason", rejection.Message, "error", fmt.Sprintf("%+v", err))...)
	writeFeatureDisabled(w, rejection.Code, rejection.Message)

	return true
}

// writeLarkInviteUpstreamError 记录飞书接口的错误（带堆栈）并返回 502。
func writeLarkInviteUpstreamError(w http.ResponseWriter, r *http.Request, err error, msg string) {
	slog.Error(msg, append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", err))...)
	writeError(w, http.StatusBadGateway, msg)
}
