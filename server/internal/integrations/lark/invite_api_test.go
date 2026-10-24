package lark

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/errors"
)

// newTestInviteClient 返回指向假飞书服务的邀请接口客户端。
func newTestInviteClient(fake *larkFakeServer) InviteAPIClient {
	return NewInviteAPIClient(HTTPClientConfig{BaseURL: fake.URL(), Now: time.Now})
}

// TestInviteAPI_GetChat 校验群信息的路径与字段映射，user_count 是字符串。
func TestInviteAPI_GetChat(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/im/v1/chats/oc_1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("auth = %q", got)
		}
		writeJSON(w, map[string]any{
			"code": 0, "msg": "ok",
			"data": map[string]any{
				"name":       "设计组",
				"avatar":     "https://img.example/chat.png",
				"user_count": "12",
			},
		})
	})

	got, err := newTestInviteClient(fake).GetChat(context.Background(), testCreds(), "oc_1")
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}

	want := InviteChat{ChatID: "oc_1", Name: "设计组", AvatarURL: "https://img.example/chat.png", MemberCount: 12}
	if got != want {
		t.Errorf("chat = %+v, want %+v", got, want)
	}
}

// TestInviteAPI_GetChat_BotNotInChat 机器人不在群里时，飞书的非 2xx 错误经 ClassifyInviteError 归为 bot_not_in_chat。
func TestInviteAPI_GetChat_BotNotInChat(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/im/v1/chats/oc_x", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":230002,"msg":"Bot/User can NOT be out of the chat."}`))
	})

	_, err := newTestInviteClient(fake).GetChat(context.Background(), testCreds(), "oc_x")
	if err == nil {
		t.Fatal("GetChat: want error")
	}
	if got := ClassifyInviteError(err); got != InviteErrBotNotInChat {
		t.Errorf("classify = %q, want %q (err=%v)", got, InviteErrBotNotInChat, err)
	}
}

// TestInviteAPI_ListBotChats_Paginates 两页合并，第二次请求带上第一页返回的 page_token。
func TestInviteAPI_ListBotChats_Paginates(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	var calls atomic.Int32
	fake.mux.HandleFunc("/open-apis/im/v1/chats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		switch calls.Add(1) {
		case 1:
			if got := r.URL.Query().Get("page_token"); got != "" {
				t.Errorf("first page_token = %q, want empty", got)
			}
			writeJSON(w, map[string]any{
				"code": 0, "msg": "ok",
				"data": map[string]any{
					"items": []any{
						map[string]any{"chat_id": "oc_1", "name": "设计组", "avatar": "https://img.example/1.png"},
						map[string]any{"chat_id": "oc_2", "name": "研发组"},
					},
					"has_more":   true,
					"page_token": "pt_2",
				},
			})
		case 2:
			if got := r.URL.Query().Get("page_token"); got != "pt_2" {
				t.Errorf("second page_token = %q, want pt_2", got)
			}
			writeJSON(w, map[string]any{
				"code": 0, "msg": "ok",
				"data": map[string]any{
					"items":    []any{map[string]any{"chat_id": "oc_3", "name": "运营组"}},
					"has_more": false,
				},
			})
		default:
			t.Errorf("unexpected extra request %d", calls.Load())
		}
	})

	got, err := newTestInviteClient(fake).ListBotChats(context.Background(), testCreds())
	if err != nil {
		t.Fatalf("ListBotChats: %v", err)
	}

	want := []InviteChat{
		{ChatID: "oc_1", Name: "设计组", AvatarURL: "https://img.example/1.png"},
		{ChatID: "oc_2", Name: "研发组"},
		{ChatID: "oc_3", Name: "运营组"},
	}
	if len(got) != len(want) {
		t.Fatalf("chats = %+v, want %d items", got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("chats[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	if calls.Load() != 2 {
		t.Errorf("requests = %d, want 2", calls.Load())
	}
}

// TestInviteAPI_ListBotChats_StopsWithoutPageToken has_more 为真但缺 page_token 时不再翻页，避免死循环。
func TestInviteAPI_ListBotChats_StopsWithoutPageToken(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	var calls atomic.Int32
	fake.mux.HandleFunc("/open-apis/im/v1/chats", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, map[string]any{
			"code": 0, "msg": "ok",
			"data": map[string]any{
				"items":    []any{map[string]any{"chat_id": "oc_1", "name": "设计组"}},
				"has_more": true,
			},
		})
	})

	got, err := newTestInviteClient(fake).ListBotChats(context.Background(), testCreds())
	if err != nil {
		t.Fatalf("ListBotChats: %v", err)
	}
	if len(got) != 1 || calls.Load() != 1 {
		t.Errorf("chats = %+v, requests = %d, want 1 chat and 1 request", got, calls.Load())
	}
}

// TestInviteAPI_GetUser 校验用户信息的路径、查询参数与字段映射。
func TestInviteAPI_GetUser(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/contact/v3/users/ou_1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.URL.Query().Get("user_id_type"); got != "open_id" {
			t.Errorf("user_id_type = %q, want open_id", got)
		}
		writeJSON(w, map[string]any{
			"code": 0, "msg": "ok",
			"data": map[string]any{
				"user": map[string]any{
					"open_id": "ou_1",
					"name":    "张三",
					"avatar": map[string]any{
						"avatar_72":  "https://img.example/u72.png",
						"avatar_240": "https://img.example/u240.png",
					},
					"email":            "zhangsan@personal.com",
					"enterprise_email": "zhangsan@corp.com",
				},
			},
		})
	})

	got, err := newTestInviteClient(fake).GetUser(context.Background(), testCreds(), "ou_1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}

	want := InviteUser{
		OpenID:          "ou_1",
		Name:            "张三",
		AvatarURL:       "https://img.example/u240.png",
		Email:           "zhangsan@personal.com",
		EnterpriseEmail: "zhangsan@corp.com",
	}
	if got != want {
		t.Errorf("user = %+v, want %+v", got, want)
	}
}

// TestInviteAPI_GetUser_NotInScope 用户不在应用可见范围时，错误归为 user_not_in_app_scope。
func TestInviteAPI_GetUser_NotInScope(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/contact/v3/users/ou_x", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"code": codeNoAvailability, "msg": "no availability"})
	})

	_, err := newTestInviteClient(fake).GetUser(context.Background(), testCreds(), "ou_x")
	if err == nil {
		t.Fatal("GetUser: want error")
	}
	if got := ClassifyInviteError(err); got != InviteErrUserNotInScope {
		t.Errorf("classify = %q, want %q (err=%v)", got, InviteErrUserNotInScope, err)
	}
}

// TestInviteAPI_LookupOpenIDByEmail 校验请求体与 open_id 返回；查不到时错误归为 user_not_found。
func TestInviteAPI_LookupOpenIDByEmail(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/contact/v3/users/batch_get_id", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.URL.Query().Get("user_id_type"); got != "open_id" {
			t.Errorf("user_id_type = %q, want open_id", got)
		}
		var body struct {
			Emails []string `json:"emails"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if len(body.Emails) != 1 {
			t.Errorf("emails = %v, want exactly one", body.Emails)
			writeJSON(w, map[string]any{"code": 0, "msg": "ok", "data": map[string]any{"user_list": []any{}}})
			return
		}

		switch body.Emails[0] {
		case "a@x.com":
			writeJSON(w, map[string]any{
				"code": 0, "msg": "ok",
				"data": map[string]any{"user_list": []any{
					map[string]any{"user_id": "ou_a", "email": "a@x.com"},
				}},
			})
		case "none@x.com":
			// 飞书查不到时仍返回该邮箱，user_id 缺省
			writeJSON(w, map[string]any{
				"code": 0, "msg": "ok",
				"data": map[string]any{"user_list": []any{
					map[string]any{"email": "none@x.com"},
				}},
			})
		default:
			t.Errorf("unexpected email %q", body.Emails[0])
		}
	})

	c := newTestInviteClient(fake)

	gotID, err := c.LookupOpenIDByEmail(context.Background(), testCreds(), "a@x.com")
	if err != nil {
		t.Fatalf("LookupOpenIDByEmail(a@x.com): %v", err)
	}
	if gotID != "ou_a" {
		t.Errorf("open_id = %q, want ou_a", gotID)
	}

	gotID, err = c.LookupOpenIDByEmail(context.Background(), testCreds(), "none@x.com")
	if err == nil {
		t.Fatalf("LookupOpenIDByEmail(none@x.com) = %q, want error", gotID)
	}
	if got := ClassifyInviteError(err); got != InviteErrUserNotFound {
		t.Errorf("classify = %q, want %q (err=%v)", got, InviteErrUserNotFound, err)
	}
}

// TestInviteAPI_SendInviteCard 校验发送卡片的路径、请求体与 message_id 返回，空 dedupeKey 不带 uuid。
func TestInviteAPI_SendInviteCard(t *testing.T) {
	const cardJSON = `{"schema":"2.0","body":{"elements":[]}}`

	tests := []struct {
		name      string
		idType    InviteReceiveIDType
		receiveID string
		dedupeKey string
		wantType  string
	}{
		{name: "open_id with uuid", idType: InviteReceiveOpenID, receiveID: "ou_1", dedupeKey: "inv-1-ou_1", wantType: "open_id"},
		{name: "chat_id without uuid", idType: InviteReceiveChatID, receiveID: "oc_1", dedupeKey: "", wantType: "chat_id"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := newLarkFake(t)
			fake.stubToken("tok", 7200)
			var hit atomic.Int32
			fake.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
				hit.Add(1)
				if r.Method != http.MethodPost {
					t.Errorf("method = %s, want POST", r.Method)
				}
				if got := r.URL.Query().Get("receive_id_type"); got != tc.wantType {
					t.Errorf("receive_id_type = %q, want %q", got, tc.wantType)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Errorf("decode body: %v", err)
				}
				if body["receive_id"] != tc.receiveID {
					t.Errorf("receive_id = %v, want %q", body["receive_id"], tc.receiveID)
				}
				if body["msg_type"] != "interactive" {
					t.Errorf("msg_type = %v, want interactive", body["msg_type"])
				}
				if body["content"] != cardJSON {
					t.Errorf("content = %v, want the card json", body["content"])
				}
				uuid, hasUUID := body["uuid"]
				if tc.dedupeKey == "" && hasUUID {
					t.Errorf("uuid = %v, want absent", uuid)
				}
				if tc.dedupeKey != "" && uuid != tc.dedupeKey {
					t.Errorf("uuid = %v, want %q", uuid, tc.dedupeKey)
				}
				writeJSON(w, map[string]any{
					"code": 0, "msg": "ok",
					"data": map[string]any{"message_id": "om_1"},
				})
			})

			got, err := newTestInviteClient(fake).SendInviteCard(context.Background(), testCreds(), tc.idType, tc.receiveID, cardJSON, tc.dedupeKey)
			if err != nil {
				t.Fatalf("SendInviteCard: %v", err)
			}
			if got != "om_1" {
				t.Errorf("message_id = %q, want om_1", got)
			}
			if hit.Load() != 1 {
				t.Errorf("requests = %d, want 1", hit.Load())
			}
		})
	}
}

// TestInviteAPI_SendInviteCard_Validation 入参缺失时直接返回错误，不发请求。
func TestInviteAPI_SendInviteCard_Validation(t *testing.T) {
	fake := newLarkFake(t)
	// 兜底 handler：任何请求（含取 token）都让测试失败。
	fake.mux.HandleFunc("/", func(_ http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	})
	c := newTestInviteClient(fake)

	tests := []struct {
		name      string
		idType    InviteReceiveIDType
		receiveID string
		cardJSON  string
	}{
		{name: "unknown id type", idType: "union_id", receiveID: "on_1", cardJSON: "{}"},
		{name: "empty receive id", idType: InviteReceiveOpenID, receiveID: "", cardJSON: "{}"},
		{name: "empty card", idType: InviteReceiveOpenID, receiveID: "ou_1", cardJSON: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := c.SendInviteCard(context.Background(), testCreds(), tc.idType, tc.receiveID, tc.cardJSON, ""); err == nil {
				t.Error("SendInviteCard: want validation error")
			}
		})
	}
}

// TestInviteAPI_PatchInviteCard 校验更新卡片走消息 patch 接口。
func TestInviteAPI_PatchInviteCard(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	var hit atomic.Int32
	fake.mux.HandleFunc("/open-apis/im/v1/messages/om_1", func(w http.ResponseWriter, r *http.Request) {
		hit.Add(1)
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if body["content"] != `{"schema":"2.0"}` {
			t.Errorf("content = %q", body["content"])
		}
		writeJSON(w, map[string]any{"code": 0, "msg": "ok"})
	})

	if err := newTestInviteClient(fake).PatchInviteCard(context.Background(), testCreds(), "om_1", `{"schema":"2.0"}`); err != nil {
		t.Fatalf("PatchInviteCard: %v", err)
	}
	if hit.Load() != 1 {
		t.Errorf("requests = %d, want 1", hit.Load())
	}
}

// TestLarkFlexInt 校验数值字段同时兼容字符串、数字、空串与 null。
func TestLarkFlexInt(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    int
		wantErr bool
	}{
		{name: "string", raw: `{"n":"12"}`, want: 12},
		{name: "number", raw: `{"n":12}`, want: 12},
		{name: "empty string", raw: `{"n":""}`, want: 0},
		{name: "null", raw: `{"n":null}`, want: 0},
		{name: "absent", raw: `{}`, want: 0},
		{name: "not a number", raw: `{"n":"abc"}`, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var v struct {
				N larkFlexInt `json:"n"`
			}
			err := json.Unmarshal([]byte(tc.raw), &v)
			if (err != nil) != tc.wantErr {
				t.Fatalf("Unmarshal(%s) err = %v, wantErr %v", tc.raw, err, tc.wantErr)
			}
			if int(v.N) != tc.want {
				t.Errorf("n = %d, want %d", v.N, tc.want)
			}
		})
	}
}

// TestClassifyInviteError 表驱动覆盖飞书错误码到邀请错误码的归类，含被包装的错误。
func TestClassifyInviteError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", err: nil, want: ""},
		{name: "bot not in chat", err: &larkAPIStatusError{StatusCode: 400, Code: 230002}, want: InviteErrBotNotInChat},
		{name: "user not in app scope", err: &larkAPIStatusError{StatusCode: 400, Code: 230013}, want: InviteErrUserNotInScope},
		{name: "open id cross app", err: &larkAPIStatusError{StatusCode: 400, Code: 99992361}, want: InviteErrOpenIDCrossApp},
		{name: "user not found 99992360", err: &larkAPIStatusError{StatusCode: 400, Code: 99992360}, want: InviteErrUserNotFound},
		{name: "user not found 41050", err: &larkAPIStatusError{StatusCode: 400, Code: 41050}, want: InviteErrUserNotFound},
		{name: "envelope error", err: &APIError{Op: "send invite card", Code: 230002, Msg: "x"}, want: InviteErrBotNotInChat},
		{name: "wrapped status error", err: errors.Wrapf(fmt.Errorf("send: %w", &larkAPIStatusError{StatusCode: 400, Code: 230013}), "chat_id=%s", "oc_1"), want: InviteErrUserNotInScope},
		{name: "unmapped code", err: &larkAPIStatusError{StatusCode: 400, Code: 230099}, want: ""},
		{name: "status error without code", err: &larkAPIStatusError{StatusCode: 502}, want: ""},
		{name: "plain error", err: errors.New("boom"), want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyInviteError(tc.err); got != tc.want {
				t.Errorf("ClassifyInviteError(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

// TestClassifyInviteConfigError 表驱动覆盖应用配置类错误的归类：232025 没开机器人，99991672 缺权限范围；
// 业务类错误码、没有错误码的错误都不算配置类，被包装的错误依然可识别。
func TestClassifyInviteConfigError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", err: nil, want: ""},
		{name: "bot not activated status error", err: &larkAPIStatusError{StatusCode: 400, Code: 232025}, want: InviteConfigBotNotEnabled},
		{name: "bot not activated envelope error", err: &APIError{Op: "list bot chats", Code: 232025, Msg: "Bot ability is not activated."}, want: InviteConfigBotNotEnabled},
		{name: "scope missing status error", err: &larkAPIStatusError{StatusCode: 400, Code: 99991672}, want: InviteConfigScopeMissing},
		{name: "scope missing envelope error", err: &APIError{Op: "get user", Code: 99991672, Msg: "Access denied"}, want: InviteConfigScopeMissing},
		{name: "wrapped", err: errors.Wrapf(fmt.Errorf("get user: %w", &larkAPIStatusError{StatusCode: 400, Code: 99991672}), "open_id=%s", "ou_1"), want: InviteConfigScopeMissing},
		{name: "business error is not config", err: &larkAPIStatusError{StatusCode: 400, Code: 230002}, want: ""},
		{name: "unmapped code", err: &larkAPIStatusError{StatusCode: 400, Code: 230099}, want: ""},
		{name: "status error without code", err: &larkAPIStatusError{StatusCode: 502}, want: ""},
		{name: "plain error", err: errors.New("boom"), want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyInviteConfigError(tc.err); got != tc.want {
				t.Errorf("ClassifyInviteConfigError(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

// TestClassifyInviteError_ConfigCodesStayUnclassified 确认配置类错误码不进 ClassifyInviteError 的四类，
// 避免调用方把它当成按接收方归类的业务错误。
func TestClassifyInviteError_ConfigCodesStayUnclassified(t *testing.T) {
	for _, code := range []int{232025, 99991672} {
		if got := ClassifyInviteError(&larkAPIStatusError{StatusCode: 400, Code: code}); got != "" {
			t.Errorf("ClassifyInviteError(code %d) = %q, want empty", code, got)
		}
	}
}

// TestInviteAPIErrorDetail 只取飞书响应顶层的错误码和 msg：真实的权限错误体里还带排查链接和 log_id，
// 它们不能出现在面向用户的说明里。
func TestInviteAPIErrorDetail(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok", 7200)
	fake.mux.HandleFunc("/open-apis/contact/v3/users/ou_1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":99991672,"msg":"Access denied. One of the following scopes is required.","error":{"log_id":"2026102312000000LOGID","troubleshooter":"https://open.feishu.cn/search?log_id=2026102312000000LOGID"}}`))
	})

	_, err := newTestInviteClient(fake).GetUser(context.Background(), testCreds(), "ou_1")
	if err == nil {
		t.Fatal("GetUser: want error")
	}

	code, msg, ok := InviteAPIErrorDetail(err)
	if !ok || code != 99991672 || msg != "Access denied. One of the following scopes is required." {
		t.Errorf("InviteAPIErrorDetail = (%d, %q, %v), want (99991672, top-level msg, true)", code, msg, ok)
	}
	if got := ClassifyInviteConfigError(err); got != InviteConfigScopeMissing {
		t.Errorf("ClassifyInviteConfigError = %q, want %q", got, InviteConfigScopeMissing)
	}
}

// TestInviteAPIErrorDetail_NotFeishu 不带飞书错误码的错误（网络错误、网关返回的非飞书响应）取不到明细。
func TestInviteAPIErrorDetail_NotFeishu(t *testing.T) {
	for name, err := range map[string]error{
		"nil":               nil,
		"network":           errors.New("dial tcp 10.0.0.1:443: connect: connection refused"),
		"gateway":           &larkAPIStatusError{StatusCode: 502, Raw: "<html>bad gateway</html>"},
		"wrapped transport": errors.Wrap(errors.New("context deadline exceeded"), "send invite card"),
	} {
		t.Run(name, func(t *testing.T) {
			if code, msg, ok := InviteAPIErrorDetail(err); ok {
				t.Errorf("InviteAPIErrorDetail = (%d, %q, true), want ok=false", code, msg)
			}
		})
	}
}
