package lark

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/pkg/errors"
)

// 飞书邀请用到的开放平台接口：查群、列出机器人所在群、查用户、按邮箱查 open_id、
// 向群或用户发送邀请卡片、更新邀请卡片。
//
// 复用 httpAPIClient 的 tenant_access_token 缓存、区域域名解析与 token 失效重试，
// 本文件只补充邀请场景的请求与响应映射。

// 飞书业务错误码。取值来自官方文档，上线前以实测结果为准，需要调整时只改这里。
const (
	// larkCodeBotNotInChat 机器人不在目标群内（im 接口：Bot/User can NOT be out of the chat）。
	larkCodeBotNotInChat = 230002

	// larkCodeUserNotInScope 机器人对该用户没有可用性，即用户不在应用可见范围内。
	// 与 codeNoAvailability 是同一个飞书错误码，这里复用，保证只定义一处。
	larkCodeUserNotInScope = codeNoAvailability

	// larkCodeOpenIDCrossApp open_id 属于其他应用，不能在当前应用下使用。
	larkCodeOpenIDCrossApp = 99992361

	// larkCodeUserIDInvalid 用户 id 不存在或无效。
	larkCodeUserIDInvalid = 99992360

	// larkCodeUserNoAuthority 没有读取该用户的权限，用户不在应用的通讯录可见范围内。
	larkCodeUserNoAuthority = 41050
)

// 邀请错误码，面向上层调用方，由 ClassifyInviteError 从飞书错误中归类得到。
const (
	// InviteErrBotNotInChat 机器人不在目标群内。
	InviteErrBotNotInChat = "bot_not_in_chat"

	// InviteErrUserNotFound 找不到目标用户。
	InviteErrUserNotFound = "user_not_found"

	// InviteErrUserNotInScope 目标用户不在应用可见范围内，机器人无法私信。
	InviteErrUserNotInScope = "user_not_in_app_scope"

	// InviteErrOpenIDCrossApp 提供的 open_id 属于其他应用。
	InviteErrOpenIDCrossApp = "open_id_cross_app"
)

// inviteErrorByLarkCode 飞书业务错误码到邀请错误码的映射。
var inviteErrorByLarkCode = map[int]string{
	larkCodeBotNotInChat:    InviteErrBotNotInChat,
	larkCodeUserNotInScope:  InviteErrUserNotInScope,
	larkCodeOpenIDCrossApp:  InviteErrOpenIDCrossApp,
	larkCodeUserIDInvalid:   InviteErrUserNotFound,
	larkCodeUserNoAuthority: InviteErrUserNotFound,
}

const (
	// inviteListChatsPageSize 列群接口每页条数，飞书上限为 100。
	inviteListChatsPageSize = 100

	// inviteListChatsMaxPages 列群最多翻页数，防止异常响应导致无限翻页。
	// 超出后返回已取到的部分，不报错。
	inviteListChatsMaxPages = 20

	// inviteMsgTypeInteractive 发送卡片消息的 msg_type。
	inviteMsgTypeInteractive = "interactive"
)

// errInviteUserNotFound 表示按邮箱查询时飞书没有匹配的用户。
// 这是 200 响应里的空结果，没有飞书错误码，所以用哨兵错误交给 ClassifyInviteError 归类。
var errInviteUserNotFound = errors.New("user not found")

// InviteReceiveIDType 是发送消息时 receive_id 的类型。
type InviteReceiveIDType string

const (
	// InviteReceiveChatID 向群发送，receive_id 为 chat_id。
	InviteReceiveChatID InviteReceiveIDType = "chat_id"

	// InviteReceiveOpenID 私信用户，receive_id 为 open_id。
	InviteReceiveOpenID InviteReceiveIDType = "open_id"
)

// InviteChat 是邀请选择器里展示的飞书群。
type InviteChat struct {
	ChatID    string
	Name      string
	AvatarURL string
	// MemberCount 为群内用户数。列群接口不返回该值，此时为 0。
	MemberCount int
}

// InviteUser 是邀请目标用户的飞书资料。
type InviteUser struct {
	OpenID          string
	Name            string
	AvatarURL       string
	Email           string
	EnterpriseEmail string
	// TenantKey 取自飞书响应，响应没有该字段时为空。
	TenantKey string
}

// InviteAPIClient 是飞书邀请卡片用到的开放平台接口。
type InviteAPIClient interface {
	// GetChat 查询群名称、头像和人数。
	GetChat(ctx context.Context, creds InstallationCredentials, chatID string) (InviteChat, error)

	// ListBotChats 列出机器人所在的全部群。
	ListBotChats(ctx context.Context, creds InstallationCredentials) ([]InviteChat, error)

	// GetUser 按 open_id 查询用户资料。
	GetUser(ctx context.Context, creds InstallationCredentials, openID string) (InviteUser, error)

	// LookupOpenIDByEmail 按邮箱查 open_id。查不到时返回的错误经 ClassifyInviteError 得到 InviteErrUserNotFound。
	LookupOpenIDByEmail(ctx context.Context, creds InstallationCredentials, email string) (string, error)

	// SendInviteCard 发送邀请卡片并返回 message_id。dedupeKey 作为飞书的 uuid 做幂等去重，为空时不携带。
	SendInviteCard(ctx context.Context, creds InstallationCredentials, idType InviteReceiveIDType, receiveID, cardJSON, dedupeKey string) (string, error)

	// PatchInviteCard 更新已发送的邀请卡片。
	PatchInviteCard(ctx context.Context, creds InstallationCredentials, messageID, cardJSON string) error
}

var _ InviteAPIClient = (*httpAPIClient)(nil)

// NewInviteAPIClient 构造邀请接口客户端，底层复用 NewHTTPAPIClient 的构造。
func NewInviteAPIClient(cfg HTTPClientConfig) InviteAPIClient {
	return NewHTTPAPIClient(cfg).(InviteAPIClient)
}

// ClassifyInviteError 把飞书错误归类为邀请错误码，归不进四类时返回空字符串。
// 同时识别非 2xx 响应（larkAPIStatusError）和 2xx 响应里的业务错误（APIError），
// 错误被 errors.Wrap 包装后依然可识别。
func ClassifyInviteError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errInviteUserNotFound) {
		return InviteErrUserNotFound
	}

	code, _, ok := larkErrorCodeMsg(err)
	if !ok {
		return ""
	}

	return inviteErrorByLarkCode[code]
}

// larkEnvelope 是飞书响应的通用外壳。
type larkEnvelope[T any] struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data T      `json:"data"`
}

// callInviteAPI 发起一次带租户 token 的飞书调用并返回 data。
// 200 响应里非 0 的业务码转成 APIError，token 类错误码同时清掉缓存，下次调用重新获取。
func callInviteAPI[T any](ctx context.Context, c *httpAPIClient, creds InstallationCredentials, op, method, path string, body any) (T, error) {
	var resp larkEnvelope[T]
	var zero T

	if err := c.doAuthedJSON(ctx, creds, method, path, body, &resp); err != nil {
		return zero, err
	}

	if resp.Code != 0 {
		if isTokenError(resp.Code) {
			c.invalidateToken(creds.AppID)
		}
		return zero, &APIError{Op: op, Code: resp.Code, Msg: resp.Msg}
	}

	return resp.Data, nil
}

// larkFlexInt 兼容飞书把数值写成字符串或数字两种形态的字段，空值按 0 处理。
type larkFlexInt int

// UnmarshalJSON 同时接受 "12" 与 12。
func (n *larkFlexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}

	v, err := strconv.Atoi(s)
	if err != nil {
		return errors.Wrapf(err, "parse number %q", s)
	}
	*n = larkFlexInt(v)

	return nil
}

// inviteChatItem 是飞书群在查群与列群响应中的公共字段。
type inviteChatItem struct {
	ChatID    string      `json:"chat_id"`
	Name      string      `json:"name"`
	Avatar    string      `json:"avatar"`
	UserCount larkFlexInt `json:"user_count"`
}

// GetChat 通过 GET /open-apis/im/v1/chats/{chat_id} 查询群信息。
// 机器人不在群内时飞书返回 230002，经 ClassifyInviteError 得到 InviteErrBotNotInChat。
func (c *httpAPIClient) GetChat(ctx context.Context, creds InstallationCredentials, chatID string) (InviteChat, error) {
	if chatID == "" {
		return InviteChat{}, errors.New("missing chat_id")
	}

	path := "/open-apis/im/v1/chats/" + url.PathEscape(chatID)
	data, err := callInviteAPI[inviteChatItem](ctx, c, creds, "get chat", http.MethodGet, path, nil)
	if err != nil {
		return InviteChat{}, errors.Wrapf(err, "get chat chat_id=%s", chatID)
	}

	return InviteChat{
		ChatID:      chatID,
		Name:        data.Name,
		AvatarURL:   data.Avatar,
		MemberCount: int(data.UserCount),
	}, nil
}

// ListBotChats 通过 GET /open-apis/im/v1/chats 分页列出机器人所在的群。
// 列群接口不返回群人数，MemberCount 为 0。
func (c *httpAPIClient) ListBotChats(ctx context.Context, creds InstallationCredentials) ([]InviteChat, error) {
	type listData struct {
		Items     []inviteChatItem `json:"items"`
		HasMore   bool             `json:"has_more"`
		PageToken string           `json:"page_token"`
	}

	chats := make([]InviteChat, 0)
	pageToken := ""

	// 下一页依赖上一页返回的 page_token，飞书没有批量接口，只能顺序翻页。
	for range inviteListChatsMaxPages {
		q := url.Values{}
		q.Set("page_size", strconv.Itoa(inviteListChatsPageSize))
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}

		data, err := callInviteAPI[listData](ctx, c, creds, "list bot chats", http.MethodGet, "/open-apis/im/v1/chats?"+q.Encode(), nil)
		if err != nil {
			return nil, errors.Wrap(err, "list bot chats")
		}

		for _, it := range data.Items {
			if it.ChatID == "" {
				continue
			}
			chats = append(chats, InviteChat{
				ChatID:      it.ChatID,
				Name:        it.Name,
				AvatarURL:   it.Avatar,
				MemberCount: int(it.UserCount),
			})
		}

		// has_more 为真却没有 page_token 时无法继续翻页，直接结束
		if !data.HasMore || data.PageToken == "" {
			break
		}
		pageToken = data.PageToken
	}

	return chats, nil
}

// GetUser 通过 GET /open-apis/contact/v3/users/{open_id} 查询用户资料。
func (c *httpAPIClient) GetUser(ctx context.Context, creds InstallationCredentials, openID string) (InviteUser, error) {
	if openID == "" {
		return InviteUser{}, errors.New("missing open_id")
	}

	type userData struct {
		User struct {
			Name   string `json:"name"`
			Avatar struct {
				Avatar240 string `json:"avatar_240"`
			} `json:"avatar"`
			Email           string `json:"email"`
			EnterpriseEmail string `json:"enterprise_email"`
			TenantKey       string `json:"tenant_key"`
		} `json:"user"`
	}

	q := url.Values{}
	q.Set("user_id_type", string(InviteReceiveOpenID))
	path := "/open-apis/contact/v3/users/" + url.PathEscape(openID) + "?" + q.Encode()

	data, err := callInviteAPI[userData](ctx, c, creds, "get user", http.MethodGet, path, nil)
	if err != nil {
		return InviteUser{}, errors.Wrapf(err, "get user open_id=%s", openID)
	}

	return InviteUser{
		OpenID:          openID,
		Name:            data.User.Name,
		AvatarURL:       data.User.Avatar.Avatar240,
		Email:           data.User.Email,
		EnterpriseEmail: data.User.EnterpriseEmail,
		TenantKey:       data.User.TenantKey,
	}, nil
}

// LookupOpenIDByEmail 通过 POST /open-apis/contact/v3/users/batch_get_id 按邮箱查 open_id。
// 飞书对查不到的邮箱仍返回 200，user_id 为空，此时返回 errInviteUserNotFound。
// 错误信息里不带邮箱，避免个人信息进入日志。
func (c *httpAPIClient) LookupOpenIDByEmail(ctx context.Context, creds InstallationCredentials, email string) (string, error) {
	if email == "" {
		return "", errors.New("missing email")
	}

	type lookupData struct {
		UserList []struct {
			UserID string `json:"user_id"`
		} `json:"user_list"`
	}

	q := url.Values{}
	q.Set("user_id_type", string(InviteReceiveOpenID))
	path := "/open-apis/contact/v3/users/batch_get_id?" + q.Encode()
	body := map[string][]string{"emails": {email}}

	data, err := callInviteAPI[lookupData](ctx, c, creds, "lookup open id by email", http.MethodPost, path, body)
	if err != nil {
		return "", errors.Wrap(err, "lookup open_id by email")
	}

	if len(data.UserList) == 0 || data.UserList[0].UserID == "" {
		return "", errors.WithStack(errInviteUserNotFound)
	}

	return data.UserList[0].UserID, nil
}

// SendInviteCard 通过 POST /open-apis/im/v1/messages 发送邀请卡片并返回 message_id。
// dedupeKey 作为飞书 uuid，同一 uuid 在 1 小时内对同一接收方至多发送成功一条，长度上限 50，为空时不携带 uuid。
func (c *httpAPIClient) SendInviteCard(ctx context.Context, creds InstallationCredentials, idType InviteReceiveIDType, receiveID, cardJSON, dedupeKey string) (string, error) {
	if idType != InviteReceiveChatID && idType != InviteReceiveOpenID {
		return "", errors.Errorf("unsupported receive_id_type %q", idType)
	}
	if receiveID == "" {
		return "", errors.New("missing receive_id")
	}
	if cardJSON == "" {
		return "", errors.New("missing card json")
	}

	type sendData struct {
		MessageID string `json:"message_id"`
	}

	body := map[string]string{
		"receive_id": receiveID,
		"msg_type":   inviteMsgTypeInteractive,
		"content":    cardJSON,
	}
	if dedupeKey != "" {
		body["uuid"] = dedupeKey
	}

	q := url.Values{}
	q.Set("receive_id_type", string(idType))

	data, err := callInviteAPI[sendData](ctx, c, creds, "send invite card", http.MethodPost, "/open-apis/im/v1/messages?"+q.Encode(), body)
	if err != nil {
		return "", errors.Wrapf(err, "send invite card receive_id_type=%s receive_id=%s", idType, receiveID)
	}
	if data.MessageID == "" {
		return "", errors.Errorf("send invite card receive_id_type=%s receive_id=%s: response missing message_id", idType, receiveID)
	}

	return data.MessageID, nil
}

// PatchInviteCard 更新已发送的邀请卡片，直接复用 PatchInteractiveCard。
func (c *httpAPIClient) PatchInviteCard(ctx context.Context, creds InstallationCredentials, messageID, cardJSON string) error {
	err := c.PatchInteractiveCard(ctx, PatchCardParams{
		InstallationID:    creds,
		LarkCardMessageID: messageID,
		CardJSON:          cardJSON,
	})
	if err != nil {
		return errors.Wrapf(err, "patch invite card message_id=%s", messageID)
	}

	return nil
}
