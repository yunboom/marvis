package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/errors"
	"github.com/spf13/cobra"
	"golang.org/x/sync/errgroup"

	"github.com/yunboom/marvis/server/internal/cli"
)

// 飞书邀请命令的参数名。
const (
	larkInviteFlagChatID         = "chat-id"
	larkInviteFlagUserID         = "user-id"
	larkInviteFlagRole           = "role"
	larkInviteFlagExpiresIn      = "expires-in"
	larkInviteFlagMaxUses        = "max-uses"
	larkInviteFlagNote           = "note"
	larkInviteFlagIdempotencyKey = "idempotency-key"
	larkInviteFlagOutput         = "output"
	larkInviteFlagStatus         = "status"
	larkInviteFlagFullID         = "full-id"
)

// 输出格式。
const (
	larkInviteOutputTable = "table"
	larkInviteOutputJSON  = "json"
)

// 加入后的角色，与服务端一致；所有者不能通过邀请授予。
const (
	larkInviteRoleMember = "member"
	larkInviteRoleAdmin  = "admin"
)

// 邀请状态，list 的 --status 取值；all 只用于筛选。
const (
	larkInviteStatusActive    = "active"
	larkInviteStatusCompleted = "completed"
	larkInviteStatusExpired   = "expired"
	larkInviteStatusRevoked   = "revoked"
	larkInviteStatusAll       = "all"
)

// larkInviteSendStatusSent 是单个接收方发送成功的状态，其余状态都按失败处理。
const larkInviteSendStatusSent = "sent"

// CLI 本地校验和兜底会产生的错误码，取值与服务端一致。
const (
	larkInviteCodeInvalidTarget  = "invalid_target"
	larkInviteCodeInvalidRequest = "invalid_request"
	larkInviteCodeSendFailed     = "send_failed"
)

// 飞书 ID 前缀：群 ID 以 oc_ 开头，用户 open_id 以 ou_ 开头，与 lark-cli 的 --chat-id、--user-id 一致。
const (
	larkInviteChatIDPrefix = "oc_"
	larkInviteOpenIDPrefix = "ou_"
)

// 有效期和幂等键的限制，与服务端一致。
const (
	larkInviteMinExpires             = time.Hour
	larkInviteMaxExpires             = 720 * time.Hour
	larkInviteDefaultExpires         = 168 * time.Hour
	larkInviteIdempotencyKeyMaxRunes = 50

	// larkInviteDay 是 --expires-in 里 1d 的时长。
	larkInviteDay = 24 * time.Hour
)

// larkInviteRevokeConcurrency 是一次 revoke 同时发出的请求数。服务端没有批量撤销接口，每个邀请要单独调用。
const larkInviteRevokeConcurrency = 4

// 表格显示。
const (
	// larkInviteTimeLayout 是表格里时间的格式，按本地时区显示，JSON 输出保留服务端的 RFC3339。
	larkInviteTimeLayout = "2006-01-02 15:04"
	// larkInviteEmptyCell 是没有值的单元格。
	larkInviteEmptyCell = "-"
)

// larkInviteDaysPattern 匹配 --expires-in 的天数写法，如 7d。
var larkInviteDaysPattern = regexp.MustCompile(`^(\d+)d$`)

// larkInviteExpiresRangeText 是 --expires-in 超出范围时的说明。
var larkInviteExpiresRangeText = "must be between " + larkInviteHoursText(larkInviteMinExpires) + " and " + larkInviteHoursText(larkInviteMaxExpires)

// larkInviteStatuses 是 list 的 --status 允许的取值。
var larkInviteStatuses = []string{
	larkInviteStatusActive,
	larkInviteStatusCompleted,
	larkInviteStatusExpired,
	larkInviteStatusRevoked,
	larkInviteStatusAll,
}

// larkInviteCmd 是 `marvis workspace lark-invite`，挂在 workspaceCmd 下。
var larkInviteCmd = newLarkInviteCmd()

// larkInviteSendRequest 是 POST /api/workspaces/{id}/lark-invites 的请求体。
// CLI 一次只发一个接收方，群和 open_id 各用一个数组字段，没用到的字段不发。
type larkInviteSendRequest struct {
	ChatIDs        []string `json:"chat_ids,omitempty"`
	UserOpenIDs    []string `json:"user_open_ids,omitempty"`
	Role           string   `json:"role"`
	ExpiresInHours int      `json:"expires_in_hours"`
	MaxUses        int      `json:"max_uses"`
	Note           string   `json:"note"`
	IdempotencyKey string   `json:"idempotency_key"`
}

// larkInviteTarget 是邀请的接收方。
type larkInviteTarget struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

// larkInviteFailure 是单个接收方的失败原因。
type larkInviteFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// larkInviteSendResult 是发送接口返回的单个接收方结果，失败时 ID 和 ExpiresAt 为空。
type larkInviteSendResult struct {
	ID        *string            `json:"id"`
	Target    larkInviteTarget   `json:"target"`
	Role      string             `json:"role"`
	ExpiresAt *string            `json:"expires_at"`
	Status    string             `json:"status"`
	Error     *larkInviteFailure `json:"error"`
}

// larkInviteJoinedUser 是通过邀请加入工作区的人。
type larkInviteJoinedUser struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	JoinedAt string `json:"joined_at"`
}

// larkInviteRecord 是列表、详情、撤销接口返回的一条邀请，只取表格要显示的字段；JSON 输出直接透传服务端响应。
type larkInviteRecord struct {
	ID        string                 `json:"id"`
	Target    larkInviteTarget       `json:"target"`
	Role      string                 `json:"role"`
	Status    string                 `json:"status"`
	UseCount  int                    `json:"use_count"`
	MaxUses   *int                   `json:"max_uses"`
	ExpiresAt string                 `json:"expires_at"`
	Joined    []larkInviteJoinedUser `json:"joined"`
}

// larkInviteRevokeOutcome 是一次撤销请求的结果。
type larkInviteRevokeOutcome struct {
	ID     string
	Raw    json.RawMessage
	Record larkInviteRecord
	Err    error
}

// larkInviteExpiresValue 是 --expires-in 的 pflag.Value：接受 Go 时长，也接受 7d 这种天数写法，
// 范围 1h 到 720h，且必须是整数小时，因为服务端按小时计。
type larkInviteExpiresValue struct {
	d time.Duration
}

// String 返回当前值；整数小时显示成 168h，而不是 168h0m0s。
func (v *larkInviteExpiresValue) String() string {
	if v.d%time.Hour == 0 {
		return larkInviteHoursText(v.d)
	}

	return v.d.String()
}

// Set 解析并校验 --expires-in 的取值。
func (v *larkInviteExpiresValue) Set(s string) error {
	d, err := parseLarkInviteExpiresIn(s)
	if err != nil {
		return err
	}

	v.d = d

	return nil
}

// Type 在帮助里显示为 duration。
func (v *larkInviteExpiresValue) Type() string { return "duration" }

// hours 返回有效期的小时数。
func (v *larkInviteExpiresValue) hours() int { return int(v.d / time.Hour) }

// parseLarkInviteExpiresIn 解析 Go 时长或 Nd 天数，并校验范围和整数小时。
func parseLarkInviteExpiresIn(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)

	var d time.Duration
	if m := larkInviteDaysPattern.FindStringSubmatch(s); m != nil {
		days, err := strconv.Atoi(m[1])
		if err != nil || days > int(larkInviteMaxExpires/larkInviteDay) {
			// 天数太大时先于换算报错，避免乘法溢出。
			return 0, errors.New(larkInviteExpiresRangeText)
		}

		d = time.Duration(days) * larkInviteDay
	} else {
		parsed, err := time.ParseDuration(s)
		if err != nil {
			return 0, errors.Errorf("invalid duration %q; use a Go duration such as 36h or a day count such as 7d", s)
		}

		d = parsed
	}

	if d < larkInviteMinExpires || d > larkInviteMaxExpires {
		return 0, errors.New(larkInviteExpiresRangeText)
	}
	if d%time.Hour != 0 {
		return 0, errors.New("must be a whole number of hours")
	}

	return d, nil
}

// larkInviteHoursText 把整数小时的时长写成 720h。
func larkInviteHoursText(d time.Duration) string {
	return strconv.FormatInt(int64(d/time.Hour), 10) + "h"
}

// newLarkInviteCmd 组装 lark-invite 命令及其子命令。
func newLarkInviteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "lark-invite",
		Short: "Send and manage Feishu workspace invite cards (admin/owner only)",
		Long: "Sends a workspace invite card on Feishu, to a chat or to one person, " +
			"and tracks it afterwards. Whoever clicks 'Join' on the card joins the " +
			"workspace with the role chosen at send time.\n\n" +
			"Needs a Feishu-enabled server and a workspace admin or owner. When the " +
			"server has the feature off, every command fails with lark_not_configured. " +
			"'send' also fails with it when the Feishu app has its bot ability off or " +
			"is missing a permission scope.",
	}
	cmd.AddCommand(
		newLarkInviteSendCmd(),
		newLarkInviteListCmd(),
		newLarkInviteGetCmd(),
		newLarkInviteRevokeCmd(),
	)

	return cmd
}

// newLarkInviteSendCmd 创建 send 子命令。
func newLarkInviteSendCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "send [workspace-id|slug|prefix]",
		Short: "Send an invite card to a Feishu chat or user",
		Long: "Sends one invite card to one receiver: a Feishu chat (--chat-id) or one " +
			"person (--user-id). Pass exactly one of the two; to invite several " +
			"receivers, run the command once per receiver.\n\n" +
			"The IDs are the same ones 'lark-cli im +messages-send' takes, so values " +
			"from lark-cli can be passed through unchanged. Find a chat with " +
			"'lark-cli im +chat-search --query <name>' and a person with " +
			"'lark-cli contact +search-user' (needs --as user).\n\n" +
			"A chat ID works with any Feishu app, but an open_id is bound to one app. " +
			"The open_id must come from the same Feishu app Marvis signs in with " +
			"(MARVIS_LARK_LOGIN_APP_ID); an open_id from another app fails with " +
			"open_id_cross_app. The Marvis bot must already be in the chat.\n\n" +
			"The optional workspace argument accepts a full UUID, a slug, or a short " +
			"UUID prefix (≥4 hex chars) as shown in 'workspace list'; if omitted the " +
			"current default workspace is used (--workspace-id / MARVIS_WORKSPACE_ID / " +
			"profile default).\n\n" +
			"On failure it prints 'Error: <code>: <message>' and exits non-zero. Codes: " +
			"lark_not_configured, permission_denied, invalid_target, invalid_request, " +
			"bot_not_in_chat, user_not_found, user_not_in_app_scope, open_id_cross_app, " +
			"send_failed. lark_not_configured also means the Feishu app has its bot " +
			"ability off or is missing a permission scope; the message says which.",
		Example: "  marvis workspace lark-invite send --chat-id oc_xxx\n" +
			"  marvis workspace lark-invite send --user-id ou_xxx --role admin --expires-in 3d --note \"Welcome\"",
		Args: cobra.MaximumNArgs(1),
		RunE: runLarkInviteSend,
	}

	flags := cmd.Flags()
	flags.String(larkInviteFlagChatID, "", "(required, mutually exclusive with --user-id) chat ID (oc_xxx)")
	flags.String(larkInviteFlagUserID, "", "(required, mutually exclusive with --chat-id) user open_id (ou_xxx)")
	flags.String(larkInviteFlagRole, larkInviteRoleMember, "Role granted on join: member or admin")
	flags.Var(&larkInviteExpiresValue{d: larkInviteDefaultExpires}, larkInviteFlagExpiresIn, "Invite validity, 1h to 720h; a day suffix such as 7d is accepted")
	flags.Int(larkInviteFlagMaxUses, 0, "Maximum number of people who can join through a chat card, 0 for no limit (ignored for a user)")
	flags.String(larkInviteFlagNote, "", "Note shown on the card, at most 200 characters")
	flags.String(larkInviteFlagIdempotencyKey, "", "Key that makes a retried send deliver only once, at most 50 characters. "+
		"A retry with the same key within 1 hour returns the original invite while it is still active; "+
		"after 1 hour, or once that invite is revoked, expired or full, the key fails with invalid_request")
	flags.String(larkInviteFlagOutput, larkInviteOutputTable, "Output format: table or json")

	return cmd
}

// newLarkInviteListCmd 创建 list 子命令。
func newLarkInviteListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list [workspace-id|slug|prefix]",
		Short: "List Feishu invites sent from a workspace",
		Long: "Lists the Feishu invite cards of a workspace, newest first. By default only " +
			"active invites are shown; pass --status all to include completed, expired " +
			"and revoked ones.\n\n" +
			"The ID column shows the first 8 characters; 'get' and 'revoke' accept that " +
			"short form, and --full-id prints the full UUID.",
		Args: cobra.MaximumNArgs(1),
		RunE: runLarkInviteList,
	}

	flags := cmd.Flags()
	flags.String(larkInviteFlagStatus, larkInviteStatusActive, "Filter by status: "+strings.Join(larkInviteStatuses, ", "))
	flags.Bool(larkInviteFlagFullID, false, "Show full UUIDs in table output")
	flags.String(larkInviteFlagOutput, larkInviteOutputTable, "Output format: table or json")

	return cmd
}

// larkInviteLookupErrorsHelp 是 get、revoke 帮助里的失败说明和错误码。
const larkInviteLookupErrorsHelp = "On failure it prints 'Error: <code>: <message>' and exits non-zero. Codes: " +
	"lark_not_configured, permission_denied, invite_not_found."

// newLarkInviteGetCmd 创建 get 子命令。
func newLarkInviteGetCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "get <invite-id>",
		Short: "Show one Feishu invite and everyone who joined through it",
		Long: "Shows one invite with the full list of people who joined. The argument is " +
			"the invite UUID or the short ID (≥4 hex chars) from 'lark-invite list'. " +
			"The workspace comes from --workspace-id, MARVIS_WORKSPACE_ID or the " +
			"profile default.\n\n" +
			larkInviteLookupErrorsHelp,
		Args: cobra.ExactArgs(1),
		RunE: runLarkInviteGet,
	}
	cmd.Flags().String(larkInviteFlagOutput, larkInviteOutputTable, "Output format: table or json")

	return cmd
}

// newLarkInviteRevokeCmd 创建 revoke 子命令。
func newLarkInviteRevokeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "revoke <invite-id>...",
		Short: "Revoke Feishu invites",
		Long: "Revokes one or more invites and marks their cards as revoked. " +
			"People who already joined stay in the workspace. Revoking an invite that " +
			"is already revoked is not an error. Each argument is an invite UUID or " +
			"the short ID (≥4 hex chars) from 'lark-invite list'; the workspace comes " +
			"from --workspace-id, MARVIS_WORKSPACE_ID or the profile default.\n\n" +
			larkInviteLookupErrorsHelp,
		Args: cobra.MinimumNArgs(1),
		RunE: runLarkInviteRevoke,
	}
	cmd.Flags().String(larkInviteFlagOutput, larkInviteOutputTable, "Output format: table or json")

	return cmd
}

// runLarkInviteSend 向一个群或一个用户发邀请卡片。
func runLarkInviteSend(cmd *cobra.Command, args []string) error {
	req, err := buildLarkInviteSendRequest(cmd)
	if err != nil {
		return err
	}

	output, err := larkInviteOutput(cmd)
	if err != nil {
		return err
	}

	wsID, err := resolveLarkInviteWorkspaceArg(cmd, args)
	if err != nil {
		return err
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp struct {
		Results json.RawMessage `json:"results"`
	}
	if err := client.PostJSON(ctx, larkInvitesPath(wsID), req, &resp); err != nil {
		return larkInviteAPIError(err, "send lark invite workspace_id="+wsID)
	}

	var results []larkInviteSendResult
	if err := json.Unmarshal(resp.Results, &results); err != nil {
		return errors.Wrapf(err, "decode lark invite send results workspace_id=%s", wsID)
	}
	if len(results) == 0 {
		return errors.Errorf("server returned no send results workspace_id=%s", wsID)
	}

	// 先输出结果再按失败退出，失败的明细也留在 stdout 里。
	if output == larkInviteOutputJSON {
		if err := cli.PrintJSON(os.Stdout, resp.Results); err != nil {
			return errors.WithStack(err)
		}
	} else {
		cli.PrintTable(os.Stdout, []string{"ID", "TYPE", "ROLE", "EXPIRES", "STATUS", "TARGET"}, larkInviteSendRows(results))
	}

	for _, result := range results {
		if result.Status != larkInviteSendStatusSent {
			return larkInviteSendFailure(result)
		}
	}

	return nil
}

// buildLarkInviteSendRequest 读取并校验 send 的参数，校验不通过时不会发出任何请求。
func buildLarkInviteSendRequest(cmd *cobra.Command) (larkInviteSendRequest, error) {
	flags := cmd.Flags()
	chatID, _ := flags.GetString(larkInviteFlagChatID)
	userID, _ := flags.GetString(larkInviteFlagUserID)
	chatID = strings.TrimSpace(chatID)
	userID = strings.TrimSpace(userID)

	var req larkInviteSendRequest
	switch {
	case chatID == "" && userID == "":
		return req, newLarkInviteCodedError(larkInviteCodeInvalidTarget, "exactly one of --chat-id or --user-id is required", nil)
	case chatID != "" && userID != "":
		return req, newLarkInviteCodedError(larkInviteCodeInvalidTarget, "--chat-id and --user-id are mutually exclusive", nil)
	case chatID != "":
		if !hasLarkInviteIDPrefix(chatID, larkInviteChatIDPrefix) {
			return req, newLarkInviteCodedError(larkInviteCodeInvalidTarget, fmt.Sprintf("--chat-id must be a chat ID starting with %s, got %q", larkInviteChatIDPrefix, chatID), nil)
		}

		req.ChatIDs = []string{chatID}
	default:
		if !hasLarkInviteIDPrefix(userID, larkInviteOpenIDPrefix) {
			return req, newLarkInviteCodedError(larkInviteCodeInvalidTarget, fmt.Sprintf("--user-id must be an open_id starting with %s, got %q", larkInviteOpenIDPrefix, userID), nil)
		}

		req.UserOpenIDs = []string{userID}
	}

	role, _ := flags.GetString(larkInviteFlagRole)
	role = strings.ToLower(strings.TrimSpace(role))
	if role != larkInviteRoleMember && role != larkInviteRoleAdmin {
		return req, newLarkInviteCodedError(larkInviteCodeInvalidRequest, fmt.Sprintf("--role must be %s or %s", larkInviteRoleMember, larkInviteRoleAdmin), nil)
	}

	key, _ := flags.GetString(larkInviteFlagIdempotencyKey)
	key = strings.TrimSpace(key)
	if utf8.RuneCountInString(key) > larkInviteIdempotencyKeyMaxRunes {
		return req, newLarkInviteCodedError(larkInviteCodeInvalidRequest, fmt.Sprintf("--idempotency-key must be at most %d characters", larkInviteIdempotencyKeyMaxRunes), nil)
	}

	expires, ok := flags.Lookup(larkInviteFlagExpiresIn).Value.(*larkInviteExpiresValue)
	if !ok {
		return req, errors.Errorf("flag --%s is not a lark invite expiry value", larkInviteFlagExpiresIn)
	}

	maxUses, _ := flags.GetInt(larkInviteFlagMaxUses)
	note, _ := flags.GetString(larkInviteFlagNote)

	req.Role = role
	req.ExpiresInHours = expires.hours()
	req.MaxUses = maxUses
	req.Note = note
	req.IdempotencyKey = key

	return req, nil
}

// hasLarkInviteIDPrefix 判断 id 以 prefix 开头且前缀之后还有内容。
func hasLarkInviteIDPrefix(id, prefix string) bool {
	return strings.HasPrefix(id, prefix) && len(id) > len(prefix)
}

// larkInviteSendRows 生成 send 的表格行，TARGET 放最后一列，避免中文字宽挤歪前面的列。
func larkInviteSendRows(results []larkInviteSendResult) [][]string {
	rows := make([][]string, 0, len(results))
	for _, result := range results {
		id := larkInviteEmptyCell
		if result.ID != nil {
			id = truncateID(*result.ID)
		}

		expires := larkInviteEmptyCell
		if result.ExpiresAt != nil {
			expires = formatLarkInviteTime(*result.ExpiresAt)
		}

		rows = append(rows, []string{id, result.Target.Type, result.Role, expires, result.Status, larkInviteTargetLabel(result.Target)})
	}

	return rows
}

// larkInviteSendFailure 把失败的发送结果转成 "Error: <code>: <message>"；服务端没给原因时用 send_failed。
func larkInviteSendFailure(result larkInviteSendResult) error {
	code, message := larkInviteCodeSendFailed, "the invite card was not sent"
	if result.Error != nil {
		if result.Error.Code != "" {
			code = result.Error.Code
		}
		if result.Error.Message != "" {
			message = result.Error.Message
		}
	}

	return newLarkInviteCodedError(code, message, nil)
}

// runLarkInviteList 列出工作区的飞书邀请。
func runLarkInviteList(cmd *cobra.Command, args []string) error {
	output, err := larkInviteOutput(cmd)
	if err != nil {
		return err
	}

	status, _ := cmd.Flags().GetString(larkInviteFlagStatus)
	status = strings.ToLower(strings.TrimSpace(status))
	if !slices.Contains(larkInviteStatuses, status) {
		return errors.Errorf("invalid --%s %q; expected one of %s", larkInviteFlagStatus, status, strings.Join(larkInviteStatuses, ", "))
	}

	wsID, err := resolveLarkInviteWorkspaceArg(cmd, args)
	if err != nil {
		return err
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	raw, records, err := fetchLarkInvites(ctx, client, wsID, status)
	if err != nil {
		return err
	}

	if output == larkInviteOutputJSON {
		return errors.WithStack(cli.PrintJSON(os.Stdout, raw))
	}

	if len(records) == 0 {
		_, _ = fmt.Fprintln(os.Stderr, "No invites found.")
		return nil
	}

	fullID, _ := cmd.Flags().GetBool(larkInviteFlagFullID)
	cli.PrintTable(os.Stdout, larkInviteRecordHeaders(), larkInviteRecordRows(records, fullID))

	return nil
}

// runLarkInviteGet 显示一条邀请和全部已加入的人。
func runLarkInviteGet(cmd *cobra.Command, args []string) error {
	output, err := larkInviteOutput(cmd)
	if err != nil {
		return err
	}

	wsID, err := requireWorkspaceID(cmd)
	if err != nil {
		return err
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ids, err := resolveLarkInviteIDs(ctx, client, wsID, args)
	if err != nil {
		return err
	}

	var raw json.RawMessage
	if err := client.GetJSON(ctx, larkInvitePath(wsID, ids[0]), &raw); err != nil {
		return larkInviteAPIError(err, "get lark invite invite_id="+ids[0])
	}

	var record larkInviteRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return errors.Wrapf(err, "decode lark invite invite_id=%s", ids[0])
	}

	if output == larkInviteOutputJSON {
		return errors.WithStack(cli.PrintJSON(os.Stdout, raw))
	}

	cli.PrintTable(os.Stdout, larkInviteRecordHeaders(), larkInviteRecordRows([]larkInviteRecord{record}, false))
	if len(record.Joined) > 0 {
		_, _ = fmt.Fprintln(os.Stdout)
		cli.PrintTable(os.Stdout, []string{"JOINED_AT", "EMAIL", "NAME"}, larkInviteJoinedRows(record.Joined))
	}

	return nil
}

// runLarkInviteRevoke 撤销一个或多个邀请。某个撤销失败不影响其他，成功的结果照常输出，有失败则返回非零退出码。
func runLarkInviteRevoke(cmd *cobra.Command, args []string) error {
	output, err := larkInviteOutput(cmd)
	if err != nil {
		return err
	}

	wsID, err := requireWorkspaceID(cmd)
	if err != nil {
		return err
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ids, err := resolveLarkInviteIDs(ctx, client, wsID, args)
	if err != nil {
		return err
	}

	// 服务端没有批量撤销接口，所以逐个请求；用有上限的并发避免串行等待，结果按参数顺序写回各自的位置。
	outcomes := make([]larkInviteRevokeOutcome, len(ids))

	var group errgroup.Group
	group.SetLimit(larkInviteRevokeConcurrency)

	for i, id := range ids {
		group.Go(func() error {
			outcome := larkInviteRevokeOutcome{ID: id}
			outcome.Err = client.DeleteJSONResponse(ctx, larkInvitePath(wsID, id), &outcome.Raw)
			if outcome.Err == nil {
				outcome.Err = json.Unmarshal(outcome.Raw, &outcome.Record)
			}

			outcomes[i] = outcome

			// 失败逐条收集，不能让一个失败取消其余请求。
			return nil
		})
	}

	if err := group.Wait(); err != nil {
		return errors.WithStack(err)
	}

	raws := make([]json.RawMessage, 0, len(outcomes))
	records := make([]larkInviteRecord, 0, len(outcomes))
	failures := make([]string, 0)

	var firstErr error
	for _, outcome := range outcomes {
		if outcome.Err != nil {
			failures = append(failures, fmt.Sprintf("Error: %s (invite %s)", larkInviteFailureText(outcome.Err), outcome.ID))
			if firstErr == nil {
				firstErr = outcome.Err
			}

			continue
		}

		raws = append(raws, outcome.Raw)
		records = append(records, outcome.Record)
	}

	if output == larkInviteOutputJSON {
		if err := cli.PrintJSON(os.Stdout, raws); err != nil {
			return errors.WithStack(err)
		}
	} else if len(records) > 0 {
		cli.PrintTable(os.Stdout, larkInviteRecordHeaders(), larkInviteRecordRows(records, false))
	}

	if len(failures) > 0 {
		return &cli.UserMessageError{Msg: strings.Join(failures, "\n"), Err: firstErr}
	}

	return nil
}

// fetchLarkInvites 拉取指定状态的邀请。返回服务端原始 JSON 供 --output json 透传，同时返回解析后的记录给表格。
func fetchLarkInvites(ctx context.Context, client *cli.APIClient, wsID, status string) (json.RawMessage, []larkInviteRecord, error) {
	path := larkInvitesPath(wsID) + "?" + url.Values{larkInviteFlagStatus: {status}}.Encode()

	var raw json.RawMessage
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return nil, nil, larkInviteAPIError(err, "list lark invites workspace_id="+wsID)
	}

	var records []larkInviteRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, nil, errors.Wrapf(err, "decode lark invites workspace_id=%s", wsID)
	}

	return raw, records, nil
}

// resolveLarkInviteIDs 把参数里的完整 UUID 或短前缀解析成完整 UUID，重复的只保留一个。
func resolveLarkInviteIDs(ctx context.Context, client *cli.APIClient, wsID string, inputs []string) ([]string, error) {
	var (
		candidates []idCandidate
		loaded     bool
	)

	// 前缀要对照全部状态的邀请解析（已撤销、已过期的也能查看）。整个命令只拉一次列表，
	// 所有短前缀共用这份结果，完整 UUID 不发请求，所以下面循环里没有逐个参数的外部调用。
	fetch := func(ctx context.Context, c *cli.APIClient) ([]idCandidate, error) {
		if loaded {
			return candidates, nil
		}

		_, records, err := fetchLarkInvites(ctx, c, wsID, larkInviteStatusAll)
		if err != nil {
			return nil, err
		}

		candidates = make([]idCandidate, 0, len(records))
		for _, record := range records {
			candidates = append(candidates, idCandidate{ID: record.ID, Display: record.ID})
		}

		loaded = true

		return candidates, nil
	}

	ids := make([]string, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		resolved, err := resolveIDByPrefix(ctx, client, "invite", input, fetch)
		if err != nil {
			return nil, err
		}

		id := strings.ToLower(resolved.ID)
		if _, dup := seen[id]; dup {
			continue
		}

		seen[id] = struct{}{}
		ids = append(ids, id)
	}

	return ids, nil
}

// resolveLarkInviteWorkspaceArg 解析 send、list 的可选工作区参数，缺省时用当前默认工作区。
func resolveLarkInviteWorkspaceArg(cmd *cobra.Command, args []string) (string, error) {
	wsID, err := resolveWorkspaceArg(cmd, args)
	if err != nil {
		return "", err
	}
	if wsID == "" {
		return "", errors.New("workspace ID is required: pass an id/slug/prefix as argument or set MARVIS_WORKSPACE_ID")
	}

	return wsID, nil
}

// larkInvitesPath 是工作区飞书邀请集合的路径。
func larkInvitesPath(wsID string) string {
	return "/api/workspaces/" + url.PathEscape(wsID) + "/lark-invites"
}

// larkInvitePath 是单条飞书邀请的路径。
func larkInvitePath(wsID, inviteID string) string {
	return larkInvitesPath(wsID) + "/" + url.PathEscape(inviteID)
}

// larkInviteOutput 读取并校验 --output。
func larkInviteOutput(cmd *cobra.Command) (string, error) {
	output, _ := cmd.Flags().GetString(larkInviteFlagOutput)
	switch output {
	case larkInviteOutputTable, larkInviteOutputJSON:
		return output, nil
	default:
		return "", errors.Errorf("invalid --%s %q; expected %s or %s", larkInviteFlagOutput, output, larkInviteOutputTable, larkInviteOutputJSON)
	}
}

// larkInviteRecordHeaders 是 list、get、revoke 共用的表头。
func larkInviteRecordHeaders() []string {
	return []string{"ID", "TYPE", "ROLE", "JOINED", "EXPIRES", "STATUS", "TARGET"}
}

// larkInviteRecordRows 生成 list、get、revoke 共用的表格行，TARGET 放最后一列。
func larkInviteRecordRows(records []larkInviteRecord, fullID bool) [][]string {
	rows := make([][]string, 0, len(records))
	for _, record := range records {
		rows = append(rows, []string{
			displayID(record.ID, fullID),
			record.Target.Type,
			record.Role,
			larkInviteJoinedCell(record.UseCount, record.MaxUses),
			formatLarkInviteTime(record.ExpiresAt),
			record.Status,
			larkInviteTargetLabel(record.Target),
		})
	}

	return rows
}

// larkInviteJoinedRows 生成已加入的人的表格行，NAME 放最后一列。
func larkInviteJoinedRows(joined []larkInviteJoinedUser) [][]string {
	rows := make([][]string, 0, len(joined))
	for _, user := range joined {
		rows = append(rows, []string{formatLarkInviteTime(user.JoinedAt), user.Email, user.Name})
	}

	return rows
}

// larkInviteJoinedCell 显示已加入人数；有人数上限时写成 已加入/上限。
func larkInviteJoinedCell(useCount int, maxUses *int) string {
	if maxUses == nil {
		return strconv.Itoa(useCount)
	}

	return fmt.Sprintf("%d/%d", useCount, *maxUses)
}

// larkInviteTargetLabel 返回接收方的显示名，没有名字时退回接收方 ID。
func larkInviteTargetLabel(target larkInviteTarget) string {
	if target.Name != "" {
		return target.Name
	}

	return target.ID
}

// formatLarkInviteTime 把服务端的 RFC3339 时间转成本地时区的表格格式，解析失败时原样显示。
func formatLarkInviteTime(value string) string {
	if value == "" {
		return larkInviteEmptyCell
	}

	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}

	return parsed.Local().Format(larkInviteTimeLayout)
}

// newLarkInviteCodedError 构造带错误码的失败，FormatError 原样输出 "Error: <code>: <message>"。
// cause 保留底层错误，退出码仍按它分类；没有底层错误时传 nil。
func newLarkInviteCodedError(code, message string, cause error) error {
	return &cli.UserMessageError{Msg: "Error: " + larkInviteCodeText(code, message), Err: cause}
}

// larkInviteCodeText 把错误码和说明写成 "<code>: <message>"，没有说明时只写错误码。
func larkInviteCodeText(code, message string) string {
	if message == "" {
		return code
	}

	return code + ": " + message
}

// larkInviteAPIError 处理一次失败的请求：服务端 4xx 带 {"error","code"} 时输出 "Error: <code>: <message>"，
// 否则带上 action 向上抛，由最外层统一格式化。
func larkInviteAPIError(err error, action string) error {
	code := cli.ServerErrorCode(err)
	if code == "" {
		return errors.Wrap(err, action)
	}

	return newLarkInviteCodedError(code, larkInviteServerMessage(err), err)
}

// larkInviteFailureText 返回一次失败请求给人看的说明：有错误码时是 "<code>: <message>"，否则是通用文案。
func larkInviteFailureText(err error) string {
	if code := cli.ServerErrorCode(err); code != "" {
		return larkInviteCodeText(code, larkInviteServerMessage(err))
	}

	return cli.FormatError(err, false)
}

// larkInviteServerMessage 取出服务端错误响应里的 error 文案，取不到时返回空。
func larkInviteServerMessage(err error) string {
	var httpErr *cli.HTTPError
	if !errors.As(err, &httpErr) {
		return ""
	}

	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &body) != nil {
		return ""
	}

	return strings.TrimSpace(body.Error)
}
