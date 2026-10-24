package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/integrations/lark"
	"github.com/yunboom/marvis/server/internal/seatcapacity"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// 测试里用到的飞书业务错误码，取值与 lark 包里的映射一致。
const (
	fakeLarkCodeBotNotInChat   = 230002
	fakeLarkCodeUserNotInScope = 230013
	fakeLarkCodeUserIDInvalid  = 99992360
	// fakeLarkCodeBotNotActivated 是应用没开机器人（232025），fakeLarkCodeScopeMissing 是应用缺权限范围（99991672）。
	fakeLarkCodeBotNotActivated = 232025
	fakeLarkCodeScopeMissing    = 99991672
	// fakeLarkCodeUnmapped 是不在任何分类里的飞书错误码。
	fakeLarkCodeUnmapped = 230099
)

// fakeInviteSend 记录一次发卡片调用。
type fakeInviteSend struct {
	IDType    lark.InviteReceiveIDType
	ReceiveID string
	CardJSON  string
	DedupeKey string
	// HasDeadline 表示发送时的 context 带超时。
	HasDeadline bool
	// CtxErr 是发送时 context 的错误，请求取消不应影响发送。
	CtxErr error
}

// fakeInvitePatch 记录一次更新卡片调用。
type fakeInvitePatch struct {
	MessageID string
	CardJSON  string
	// HasDeadline 表示更新时的 context 带超时。
	HasDeadline bool
	// CtxErr 是更新时 context 的错误，回调结束不应取消回应之后的更新。
	CtxErr error
}

// fakeInviteAPI 是测试用的飞书邀请接口桩：按 ID 返回预设结果或错误，并记录调用。
// 发送在 goroutine 池里并发执行，所有字段的读写都在 mu 保护下。
type fakeInviteAPI struct {
	mu sync.Mutex

	chats    map[string]lark.InviteChat
	users    map[string]lark.InviteUser
	emails   map[string]string
	sendErrs map[string]error // 按 receive_id 命中的发送错误
	patchErr error
	botChats []lark.InviteChat
	// listChatsErr 非空时 ListBotChats 一律返回它，模拟列群接口的业务错误。
	listChatsErr error
	// blockGetUser 为 true 时 GetUser 一直阻塞到调用方的 context 结束，模拟通讯录接口无响应。
	blockGetUser bool
	// getUserErr 非空时 GetUser 一律返回它，模拟通讯录接口的业务错误。
	getUserErr error
	// onPatch 非空时在每次更新卡片、记录调用之前执行（不持有 mu），用来在更新途中插入撤销或断开请求。
	onPatch func()

	calls        int
	sends        []fakeInviteSend // 成功的发送
	sendAttempts []fakeInviteSend // 全部发送尝试，含失败
	patches      []fakeInvitePatch
	lookups      []string
	msgSeq       int
}

var _ lark.InviteAPIClient = (*fakeInviteAPI)(nil)

func newFakeInviteAPI() *fakeInviteAPI {
	return &fakeInviteAPI{
		chats:    map[string]lark.InviteChat{},
		users:    map[string]lark.InviteUser{},
		emails:   map[string]string{},
		sendErrs: map[string]error{},
	}
}

func (f *fakeInviteAPI) GetChat(_ context.Context, _ lark.InstallationCredentials, chatID string) (lark.InviteChat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++
	chat, ok := f.chats[chatID]
	if !ok {
		return lark.InviteChat{}, &lark.APIError{Op: "get chat", Code: fakeLarkCodeBotNotInChat, Msg: "bot not in chat"}
	}

	return chat, nil
}

func (f *fakeInviteAPI) ListBotChats(_ context.Context, _ lark.InstallationCredentials) ([]lark.InviteChat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++
	if f.listChatsErr != nil {
		return nil, f.listChatsErr
	}

	return f.botChats, nil
}

func (f *fakeInviteAPI) GetUser(ctx context.Context, _ lark.InstallationCredentials, openID string) (lark.InviteUser, error) {
	f.mu.Lock()
	f.calls++
	block := f.blockGetUser
	getUserErr := f.getUserErr
	user, ok := f.users[openID]
	f.mu.Unlock()

	if block {
		<-ctx.Done()
		return lark.InviteUser{}, ctx.Err()
	}
	if getUserErr != nil {
		return lark.InviteUser{}, getUserErr
	}
	if !ok {
		return lark.InviteUser{}, &lark.APIError{Op: "get user", Code: fakeLarkCodeUserIDInvalid, Msg: "invalid user id"}
	}

	return user, nil
}

func (f *fakeInviteAPI) LookupOpenIDByEmail(_ context.Context, _ lark.InstallationCredentials, email string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++
	f.lookups = append(f.lookups, email)
	openID, ok := f.emails[email]
	if !ok {
		return "", &lark.APIError{Op: "lookup open id by email", Code: fakeLarkCodeUserIDInvalid, Msg: "user not found"}
	}

	return openID, nil
}

func (f *fakeInviteAPI) SendInviteCard(ctx context.Context, _ lark.InstallationCredentials, idType lark.InviteReceiveIDType, receiveID, cardJSON, dedupeKey string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++
	_, hasDeadline := ctx.Deadline()
	send := fakeInviteSend{IDType: idType, ReceiveID: receiveID, CardJSON: cardJSON, DedupeKey: dedupeKey, HasDeadline: hasDeadline, CtxErr: ctx.Err()}
	f.sendAttempts = append(f.sendAttempts, send)
	if err := f.sendErrs[receiveID]; err != nil {
		return "", err
	}

	f.msgSeq++
	f.sends = append(f.sends, send)

	return fmt.Sprintf("om_fake_%d", f.msgSeq), nil
}

// setSendErr 设置或清除（err 为 nil）对某个 receive_id 的发送错误。
func (f *fakeInviteAPI) setSendErr(receiveID string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if err == nil {
		delete(f.sendErrs, receiveID)
		return
	}
	f.sendErrs[receiveID] = err
}

// attempts 返回全部发送尝试的副本。
func (f *fakeInviteAPI) attempts() []fakeInviteSend {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]fakeInviteSend(nil), f.sendAttempts...)
}

func (f *fakeInviteAPI) PatchInviteCard(ctx context.Context, _ lark.InstallationCredentials, messageID, cardJSON string) error {
	f.mu.Lock()
	hook := f.onPatch
	f.mu.Unlock()

	if hook != nil {
		hook()
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++
	_, hasDeadline := ctx.Deadline()
	f.patches = append(f.patches, fakeInvitePatch{MessageID: messageID, CardJSON: cardJSON, HasDeadline: hasDeadline, CtxErr: ctx.Err()})

	return f.patchErr
}

// snapshot 返回调用记录的副本，避免断言时与仍在运行的 goroutine 竞争。
func (f *fakeInviteAPI) snapshot() (calls int, sends []fakeInviteSend, patches []fakeInvitePatch, lookups []string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.calls, append([]fakeInviteSend(nil), f.sends...), append([]fakeInvitePatch(nil), f.patches...), append([]string(nil), f.lookups...)
}

// useFakeInviteAPI 把 testHandler 的飞书邀请接口换成 api（可为 nil），测试结束时还原。
func useFakeInviteAPI(t *testing.T, api lark.InviteAPIClient) {
	t.Helper()

	prevAPI, prevCreds := testHandler.LarkInviteAPI, testHandler.LarkInviteCreds
	testHandler.LarkInviteAPI = api
	testHandler.LarkInviteCreds = lark.InstallationCredentials{AppID: "cli_lark_invite_test", AppSecret: "secret"}
	t.Cleanup(func() {
		testHandler.LarkInviteAPI = prevAPI
		testHandler.LarkInviteCreds = prevCreds
	})
}

// larkInviteLogBuffer 是并发安全的日志缓冲，被测代码可能在后台 goroutine 里写日志。
type larkInviteLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *larkInviteLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p)
}

func (b *larkInviteLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}

// captureLarkInviteLogs 把默认 logger 换成写入缓冲的文本 logger，测试结束时还原。
func captureLarkInviteLogs(t *testing.T) *larkInviteLogBuffer {
	t.Helper()

	logs := &larkInviteLogBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	return logs
}

// panickingInviteAPI 在查某个群时 panic，模拟发送链路里的意外 panic。
type panickingInviteAPI struct {
	*fakeInviteAPI
	panicChatID string
}

func (p *panickingInviteAPI) GetChat(ctx context.Context, creds lark.InstallationCredentials, chatID string) (lark.InviteChat, error) {
	if chatID == p.panicChatID {
		panic("get chat blew up in test")
	}

	return p.fakeInviteAPI.GetChat(ctx, creds, chatID)
}

// uniqueLarkID 生成带前缀的测试 ID，避免和其他测试的行冲突。
func uniqueLarkID(prefix string) string {
	return fmt.Sprintf("%s%d_%d", prefix, time.Now().UnixNano(), testSeq.Add(1))
}

// uniqueLarkEmail 生成测试邮箱，全小写，与服务端规范化后的形式一致。
func uniqueLarkEmail(name string) string {
	return fmt.Sprintf("%s-%d-%d@lark-invite.test", name, time.Now().UnixNano(), testSeq.Add(1))
}

// cleanupLarkInvitesByTarget 在测试结束时删除这些接收方的邀请及其加入记录。
func cleanupLarkInvitesByTarget(t *testing.T, targetIDs ...string) {
	t.Helper()

	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = testPool.Exec(ctx, `
			DELETE FROM lark_invite_join
			WHERE invite_id IN (SELECT id FROM lark_invite WHERE workspace_id = $1 AND target_id = ANY($2::text[]))
		`, testWorkspaceID, targetIDs)
		_, _ = testPool.Exec(ctx, `DELETE FROM lark_invite WHERE workspace_id = $1 AND target_id = ANY($2::text[])`, testWorkspaceID, targetIDs)
	})
}

// postLarkInvites 以 testUserID 的身份调用发送接口，headers 追加额外请求头。
func postLarkInvites(t *testing.T, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()

	req := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/lark-invites", body)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req = withURLParam(req, "id", testWorkspaceID)

	w := httptest.NewRecorder()
	testHandler.SendLarkInvites(w, req)

	return w
}

// decodeLarkInviteResults 断言 200 并解析 {"results":[...]}。
func decodeLarkInviteResults(t *testing.T, w *httptest.ResponseRecorder) []LarkInviteSendResult {
	t.Helper()

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Results []LarkInviteSendResult `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode send results: %v, body = %s", err, w.Body.String())
	}

	return resp.Results
}

// assertLarkInviteError 断言响应的状态码和错误码。
func assertLarkInviteError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()

	if w.Code != status {
		t.Fatalf("status = %d, want %d, body = %s", w.Code, status, w.Body.String())
	}

	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v, body = %s", err, w.Body.String())
	}
	if body["code"] != code {
		t.Fatalf("code = %q, want %q, body = %s", body["code"], code, w.Body.String())
	}
}

// larkInviteRow 是断言用的 lark_invite 行。
type larkInviteRow struct {
	ID            string
	TargetIDType  string
	TargetOpenID  *string
	MaxUses       *int32
	LarkMessageID *string
	SentByUserID  string
	SentByAgentID *string
}

// loadLarkInviteRow 读取某个接收方的邀请行，没有时返回 false。
func loadLarkInviteRow(t *testing.T, targetID string) (larkInviteRow, bool) {
	t.Helper()

	var row larkInviteRow
	err := testPool.QueryRow(context.Background(), `
		SELECT id::text, target_id_type, target_open_id, max_uses, lark_message_id, sent_by_user_id::text, sent_by_agent_id::text
		FROM lark_invite
		WHERE workspace_id = $1 AND target_id = $2
	`, testWorkspaceID, targetID).Scan(&row.ID, &row.TargetIDType, &row.TargetOpenID, &row.MaxUses, &row.LarkMessageID, &row.SentByUserID, &row.SentByAgentID)
	if isNotFound(err) {
		return larkInviteRow{}, false
	}
	if err != nil {
		t.Fatalf("load lark invite row target_id=%s: %v", targetID, err)
	}

	return row, true
}

func TestSendLarkInvites_ChatAndUser(t *testing.T) {
	api := newFakeInviteAPI()
	chatID := uniqueLarkID("oc_")
	openID := uniqueLarkID("ou_")
	api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "产品群", AvatarURL: "https://example.com/chat.png", MemberCount: 12}
	api.users[openID] = lark.InviteUser{OpenID: openID, Name: "张三", AvatarURL: "https://example.com/user.png"}
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, chatID, openID)

	w := postLarkInvites(t, map[string]any{
		"chat_ids":         []string{chatID},
		"user_open_ids":    []string{openID},
		"role":             "member",
		"expires_in_hours": 168,
		"max_uses":         0,
		"note":             "欢迎加入",
	}, nil)
	results := decodeLarkInviteResults(t, w)

	if len(results) != 2 {
		t.Fatalf("results = %d, want 2: %s", len(results), w.Body.String())
	}
	byTarget := map[string]LarkInviteSendResult{}
	for _, res := range results {
		if res.Status != larkInviteSendStatusSent || res.ID == nil || res.Error != nil {
			t.Fatalf("result not sent: %+v", res)
		}
		byTarget[res.Target.ID] = res
	}

	chat := byTarget[chatID]
	if chat.Target.Type != larkInviteTargetChat || chat.Target.IDType != larkInviteIDTypeChatID || chat.Target.Name != "产品群" {
		t.Fatalf("chat target = %+v", chat.Target)
	}
	if chat.MaxUses != nil {
		t.Fatalf("chat max_uses = %d, want null", *chat.MaxUses)
	}
	if chat.ExpiresAt == nil || chat.Role != larkInviteRoleMember {
		t.Fatalf("chat result = %+v", chat)
	}

	user := byTarget[openID]
	if user.Target.Type != larkInviteTargetUser || user.Target.IDType != larkInviteIDTypeOpenID || user.Target.Name != "张三" {
		t.Fatalf("user target = %+v", user.Target)
	}
	if user.MaxUses == nil || *user.MaxUses != 1 {
		t.Fatalf("user max_uses = %v, want 1", user.MaxUses)
	}

	chatRow, ok := loadLarkInviteRow(t, chatID)
	if !ok {
		t.Fatal("chat invite row missing")
	}
	if chatRow.LarkMessageID == nil || *chatRow.LarkMessageID == "" {
		t.Fatal("chat invite lark_message_id not stored")
	}
	if chatRow.MaxUses != nil {
		t.Fatalf("chat invite max_uses = %d, want NULL", *chatRow.MaxUses)
	}
	if chatRow.ID != *chat.ID {
		t.Fatalf("chat invite id = %s, result id = %s", chatRow.ID, *chat.ID)
	}

	userRow, ok := loadLarkInviteRow(t, openID)
	if !ok {
		t.Fatal("user invite row missing")
	}
	if userRow.LarkMessageID == nil || *userRow.LarkMessageID == "" {
		t.Fatal("user invite lark_message_id not stored")
	}
	if userRow.MaxUses == nil || *userRow.MaxUses != 1 {
		t.Fatalf("user invite max_uses = %v, want 1", userRow.MaxUses)
	}
	if userRow.TargetOpenID == nil || *userRow.TargetOpenID != openID {
		t.Fatalf("user invite target_open_id = %v, want %s", userRow.TargetOpenID, openID)
	}
	if userRow.SentByUserID != testUserID || userRow.SentByAgentID != nil {
		t.Fatalf("sent_by = %s / %v, want %s / nil", userRow.SentByUserID, userRow.SentByAgentID, testUserID)
	}

	_, sends, _, _ := api.snapshot()
	if len(sends) != 2 {
		t.Fatalf("sends = %d, want 2", len(sends))
	}
	for _, s := range sends {
		switch s.ReceiveID {
		case chatID:
			if s.IDType != lark.InviteReceiveChatID {
				t.Fatalf("chat send id type = %s", s.IDType)
			}
			if !strings.Contains(s.CardJSON, *chat.ID) || !strings.Contains(s.CardJSON, handlerTestName) {
				t.Fatalf("chat card missing invite id or inviter: %s", s.CardJSON)
			}
		case openID:
			if s.IDType != lark.InviteReceiveOpenID {
				t.Fatalf("user send id type = %s", s.IDType)
			}
		default:
			t.Fatalf("unexpected receive id %s", s.ReceiveID)
		}
		if s.DedupeKey != "" {
			t.Fatalf("dedupe key = %q, want empty without idempotency key", s.DedupeKey)
		}
	}
}

func TestSendLarkInvites_EmailResolvedToOpenID(t *testing.T) {
	api := newFakeInviteAPI()
	email := uniqueLarkEmail("lisi")
	openID := uniqueLarkID("ou_")
	api.emails[email] = openID
	api.users[openID] = lark.InviteUser{OpenID: openID, Name: "李四"}
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, email)

	w := postLarkInvites(t, map[string]any{
		"user_emails":      []string{email},
		"role":             "admin",
		"expires_in_hours": 24,
	}, nil)
	results := decodeLarkInviteResults(t, w)

	if len(results) != 1 || results[0].Status != larkInviteSendStatusSent {
		t.Fatalf("results = %s", w.Body.String())
	}
	got := results[0]
	if got.Target.ID != email || got.Target.IDType != larkInviteIDTypeEmail || got.Target.Type != larkInviteTargetUser || got.Target.Name != "李四" {
		t.Fatalf("target = %+v", got.Target)
	}
	if got.Role != larkInviteRoleAdmin {
		t.Fatalf("role = %s, want admin", got.Role)
	}

	_, sends, _, lookups := api.snapshot()
	if len(lookups) != 1 || lookups[0] != email {
		t.Fatalf("lookups = %v, want [%s]", lookups, email)
	}
	if len(sends) != 1 || sends[0].ReceiveID != openID || sends[0].IDType != lark.InviteReceiveOpenID {
		t.Fatalf("sends = %+v, want one open_id send to %s", sends, openID)
	}

	row, ok := loadLarkInviteRow(t, email)
	if !ok {
		t.Fatal("invite row missing")
	}
	if row.TargetIDType != larkInviteIDTypeEmail || row.TargetOpenID == nil || *row.TargetOpenID != openID {
		t.Fatalf("row = %+v, want email target resolved to %s", row, openID)
	}
}

func TestSendLarkInvites_PartialFailure(t *testing.T) {
	api := newFakeInviteAPI()
	good := uniqueLarkID("oc_good_")
	bad := uniqueLarkID("oc_bad_")
	api.chats[good] = lark.InviteChat{ChatID: good, Name: "好群"}
	api.chats[bad] = lark.InviteChat{ChatID: bad, Name: "坏群"}
	api.sendErrs[bad] = &lark.APIError{Op: "send invite card", Code: fakeLarkCodeBotNotInChat, Msg: "bot not in chat"}
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, good, bad)

	w := postLarkInvites(t, map[string]any{
		"chat_ids":         []string{good, bad},
		"expires_in_hours": 72,
	}, nil)
	results := decodeLarkInviteResults(t, w)

	if len(results) != 2 {
		t.Fatalf("results = %s", w.Body.String())
	}
	byTarget := map[string]LarkInviteSendResult{}
	for _, res := range results {
		byTarget[res.Target.ID] = res
	}

	if byTarget[good].Status != larkInviteSendStatusSent {
		t.Fatalf("good result = %+v", byTarget[good])
	}
	failed := byTarget[bad]
	if failed.Status != larkInviteSendStatusFailed || failed.Error == nil || failed.Error.Code != lark.InviteErrBotNotInChat {
		t.Fatalf("bad result = %+v", failed)
	}
	if failed.ID != nil {
		t.Fatalf("failed result id = %s, want null", *failed.ID)
	}

	if _, ok := loadLarkInviteRow(t, bad); ok {
		t.Fatal("failed target still has an invite row")
	}
	if _, ok := loadLarkInviteRow(t, good); !ok {
		t.Fatal("successful target has no invite row")
	}
}

// TestSendLarkInvites_PanicFailsOnlyThatTarget 确认发送池里的 panic 不会带崩进程：出 panic 的接收方记为 send_failed，
// 日志带堆栈，其他接收方照常发送。
func TestSendLarkInvites_PanicFailsOnlyThatTarget(t *testing.T) {
	logs := captureLarkInviteLogs(t)
	fake := newFakeInviteAPI()
	good := uniqueLarkID("oc_good_")
	boom := uniqueLarkID("oc_boom_")
	fake.chats[good] = lark.InviteChat{ChatID: good, Name: "好群"}
	useFakeInviteAPI(t, &panickingInviteAPI{fakeInviteAPI: fake, panicChatID: boom})
	cleanupLarkInvitesByTarget(t, good, boom)

	results := decodeLarkInviteResults(t, postLarkInvites(t, map[string]any{
		"chat_ids":         []string{good, boom},
		"expires_in_hours": 72,
	}, nil))

	if len(results) != 2 {
		t.Fatalf("results = %+v, want two", results)
	}
	if results[0].Status != larkInviteSendStatusSent || results[0].Target.ID != good {
		t.Fatalf("good result = %+v, want sent", results[0])
	}

	panicked := results[1]
	if panicked.Target.ID != boom || panicked.Status != larkInviteSendStatusFailed || panicked.Error == nil || panicked.Error.Code != larkInviteCodeSendFailed {
		t.Fatalf("panicked result = %+v, want failed/%s for %s", panicked, larkInviteCodeSendFailed, boom)
	}
	if panicked.ID != nil {
		t.Fatalf("panicked result id = %s, want null", *panicked.ID)
	}

	got := logs.String()
	if !strings.Contains(got, "send lark invite panicked") || !strings.Contains(got, "get chat blew up in test") || !strings.Contains(got, "panickingInviteAPI") {
		t.Fatalf("panic not logged with its stack; log was:\n%s", got)
	}
}

func TestSendLarkInvites_Validation(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)

	validChat := []string{"oc_validation_chat"}
	cases := []struct {
		name string
		body map[string]any
		code string
	}{
		{name: "no receivers", body: map[string]any{"expires_in_hours": 168}, code: larkInviteCodeInvalidTarget},
		{name: "chat id without oc_", body: map[string]any{"chat_ids": []string{"ou_wrong"}, "expires_in_hours": 168}, code: larkInviteCodeInvalidTarget},
		{name: "open id without ou_", body: map[string]any{"user_open_ids": []string{"oc_wrong"}, "expires_in_hours": 168}, code: larkInviteCodeInvalidTarget},
		{name: "malformed email", body: map[string]any{"user_emails": []string{"not-an-email"}, "expires_in_hours": 168}, code: larkInviteCodeInvalidTarget},
		{name: "owner role", body: map[string]any{"chat_ids": validChat, "role": "owner", "expires_in_hours": 168}, code: larkInviteCodeInvalidRequest},
		{name: "zero expiry", body: map[string]any{"chat_ids": validChat, "expires_in_hours": 0}, code: larkInviteCodeInvalidRequest},
		{name: "expiry over 30 days", body: map[string]any{"chat_ids": validChat, "expires_in_hours": 721}, code: larkInviteCodeInvalidRequest},
		{name: "negative max uses", body: map[string]any{"chat_ids": validChat, "expires_in_hours": 168, "max_uses": -1}, code: larkInviteCodeInvalidRequest},
		{name: "note over 200 characters", body: map[string]any{"chat_ids": validChat, "expires_in_hours": 168, "note": strings.Repeat("字", 201)}, code: larkInviteCodeInvalidRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postLarkInvites(t, tc.body, nil)
			assertLarkInviteError(t, w, http.StatusBadRequest, tc.code)
		})
	}

	if calls, _, _, _ := api.snapshot(); calls != 0 {
		t.Fatalf("Feishu calls = %d, want 0 for invalid requests", calls)
	}
}

func TestSendLarkInvites_IdempotencyKey(t *testing.T) {
	api := newFakeInviteAPI()
	chatID := uniqueLarkID("oc_")
	api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "幂等群"}
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, chatID)

	key := uniqueLarkID("retry-")
	body := map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168, "idempotency_key": key}

	first := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))
	second := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))

	if len(first) != 1 || len(second) != 1 || first[0].ID == nil || second[0].ID == nil {
		t.Fatalf("first = %+v, second = %+v", first, second)
	}
	if *first[0].ID != *second[0].ID || second[0].Status != larkInviteSendStatusSent {
		t.Fatalf("second result = %+v, want the first invite %s", second[0], *first[0].ID)
	}

	_, sends, _, _ := api.snapshot()
	if len(sends) != 1 {
		t.Fatalf("sends = %d, want 1", len(sends))
	}
	sum := sha256.Sum256([]byte(key + "\x00" + chatID))
	if want := hex.EncodeToString(sum[:])[:32]; sends[0].DedupeKey != want {
		t.Fatalf("dedupe key = %q, want %q", sends[0].DedupeKey, want)
	}
	if want := expectedKeyedInviteID(key, chatID); *first[0].ID != want {
		t.Fatalf("invite id = %s, want derived %s", *first[0].ID, want)
	}
}

// expectedKeyedInviteID 按 Ruling 12 独立计算带幂等键的邀请 id。
func expectedKeyedInviteID(key, targetID string) string {
	return uuid.NewSHA1(uuid.MustParse("d4a2c2e7-bdae-47ae-964f-d162526e23eb"), []byte(testWorkspaceID+"\x00"+key+"\x00"+targetID)).String()
}

func TestSendLarkInvites_KeyedAmbiguousFailureKeepsRowAndRetries(t *testing.T) {
	api := newFakeInviteAPI()
	chatID := uniqueLarkID("oc_ambiguous_")
	api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "超时群"}
	api.setSendErr(chatID, errors.New("context deadline exceeded"))
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, chatID)

	key := uniqueLarkID("ambiguous-")
	body := map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168, "idempotency_key": key}

	first := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))
	if len(first) != 1 || first[0].Status != larkInviteSendStatusFailed || first[0].Error == nil || first[0].Error.Code != larkInviteCodeSendFailed {
		t.Fatalf("first result = %+v, want failed/send_failed", first)
	}

	row, ok := loadLarkInviteRow(t, chatID)
	if !ok {
		t.Fatal("ambiguous failure with a key deleted the invite row")
	}
	if row.LarkMessageID != nil {
		t.Fatalf("lark_message_id = %s, want NULL after failed send", *row.LarkMessageID)
	}
	if want := expectedKeyedInviteID(key, chatID); row.ID != want {
		t.Fatalf("invite id = %s, want derived %s", row.ID, want)
	}

	api.setSendErr(chatID, nil)
	second := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))
	if len(second) != 1 || second[0].Status != larkInviteSendStatusSent || second[0].ID == nil || *second[0].ID != row.ID {
		t.Fatalf("retry result = %+v, want sent with invite %s", second, row.ID)
	}

	stored, ok := loadLarkInviteRow(t, chatID)
	if !ok || stored.LarkMessageID == nil || *stored.LarkMessageID == "" {
		t.Fatalf("retry did not store lark_message_id: %+v", stored)
	}

	attempts := api.attempts()
	if len(attempts) != 2 {
		t.Fatalf("send attempts = %d, want 2", len(attempts))
	}
	for i, a := range attempts {
		if a.DedupeKey != attempts[0].DedupeKey || !strings.Contains(a.CardJSON, row.ID) {
			t.Fatalf("attempt %d dedupe key %q / card does not carry invite %s", i, a.DedupeKey, row.ID)
		}
		if !a.HasDeadline || a.CtxErr != nil {
			t.Fatalf("attempt %d context: deadline=%v err=%v, want bounded and live", i, a.HasDeadline, a.CtxErr)
		}
	}
}

// 改写已有邀请行的 SQL，模拟重试前邀请已过窗口、已撤销、已过期或已用满。
const (
	larkInviteSQLAgeRow    = `UPDATE lark_invite SET created_at = now() - interval '61 minutes' WHERE id = $1`
	larkInviteSQLRevokeRow = `UPDATE lark_invite SET revoked_at = now() WHERE id = $1`
	larkInviteSQLExpireRow = `UPDATE lark_invite SET expires_at = now() - interval '1 minute' WHERE id = $1`
	larkInviteSQLFillRow   = `UPDATE lark_invite SET max_uses = 1, use_count = 1 WHERE id = $1`
)

// TestSendLarkInvites_KeyedReplayWindow 覆盖 Ruling 20：幂等键命中的已有邀请只在仍有效、且创建不到 1 小时时重放；
// 没有消息 ID 的行也只在同样条件下补发；其余情况这个接收方返回 invalid_request，不再发卡片。
func TestSendLarkInvites_KeyedReplayWindow(t *testing.T) {
	cases := []struct {
		name string
		// unsent 为 true 时第一次发送以结果不明失败，留下没有消息 ID 的行。
		unsent bool
		// mutate 在重试前改写邀请行，为空时不改。
		mutate string
		// wantReplay 为 true 时重试返回同一张邀请；否则返回 invalid_request，且不再尝试发送。
		wantReplay bool
	}{
		{name: "active within the window replays", wantReplay: true},
		{name: "active older than the window", mutate: larkInviteSQLAgeRow},
		{name: "revoked", mutate: larkInviteSQLRevokeRow},
		{name: "expired", mutate: larkInviteSQLExpireRow},
		{name: "full", mutate: larkInviteSQLFillRow},
		{name: "unsent within the window re-sends", unsent: true, wantReplay: true},
		{name: "unsent and revoked", unsent: true, mutate: larkInviteSQLRevokeRow},
		{name: "unsent older than the window", unsent: true, mutate: larkInviteSQLAgeRow},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := newFakeInviteAPI()
			chatID := uniqueLarkID("oc_replay_")
			api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "重放群"}
			if tc.unsent {
				api.setSendErr(chatID, errors.New("context deadline exceeded"))
			}
			useFakeInviteAPI(t, api)
			cleanupLarkInvitesByTarget(t, chatID)

			body := map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168, "idempotency_key": uniqueLarkID("replay-")}
			decodeLarkInviteResults(t, postLarkInvites(t, body, nil))

			row, ok := loadLarkInviteRow(t, chatID)
			if !ok {
				t.Fatal("first send left no invite row")
			}
			if tc.mutate != "" {
				dbfx.Exec(t, tc.mutate, row.ID)
			}
			api.setSendErr(chatID, nil)
			attemptsBefore := len(api.attempts())

			results := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))
			if len(results) != 1 {
				t.Fatalf("results = %+v, want one", results)
			}
			got := results[0]

			if tc.wantReplay {
				if got.Status != larkInviteSendStatusSent || got.ID == nil || *got.ID != row.ID {
					t.Fatalf("retry result = %+v, want sent with invite %s", got, row.ID)
				}
				_, sends, _, _ := api.snapshot()
				if len(sends) != 1 {
					t.Fatalf("delivered cards = %d, want exactly 1", len(sends))
				}
				return
			}

			if got.Status != larkInviteSendStatusFailed || got.Error == nil || got.Error.Code != larkInviteCodeInvalidRequest {
				t.Fatalf("retry result = %+v, want failed/%s", got, larkInviteCodeInvalidRequest)
			}
			if got.Error.Message != larkInviteMsgKeyNotReplayable {
				t.Fatalf("error message = %q, want %q", got.Error.Message, larkInviteMsgKeyNotReplayable)
			}
			if got.ID != nil {
				t.Fatalf("rejected retry returned invite id %s", *got.ID)
			}
			if n := len(api.attempts()); n != attemptsBefore {
				t.Fatalf("send attempts after retry = %d, want %d (no new card)", n, attemptsBefore)
			}
		})
	}
}

func TestSendLarkInvites_KeyedClassifiedFailureDeletesRow(t *testing.T) {
	api := newFakeInviteAPI()
	chatID := uniqueLarkID("oc_rejected_")
	api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "拒绝群"}
	api.setSendErr(chatID, &lark.APIError{Op: "send invite card", Code: fakeLarkCodeBotNotInChat, Msg: "bot not in chat"})
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, chatID)

	body := map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168, "idempotency_key": uniqueLarkID("rejected-")}
	results := decodeLarkInviteResults(t, postLarkInvites(t, body, nil))

	if len(results) != 1 || results[0].Status != larkInviteSendStatusFailed || results[0].Error == nil || results[0].Error.Code != lark.InviteErrBotNotInChat {
		t.Fatalf("result = %+v, want failed/bot_not_in_chat", results)
	}
	if _, ok := loadLarkInviteRow(t, chatID); ok {
		t.Fatal("classified failure with a key kept the invite row")
	}
}

func TestSendLarkInvites_KeyedDistinctTargets(t *testing.T) {
	api := newFakeInviteAPI()
	chatA := uniqueLarkID("oc_keyed_a_")
	chatB := uniqueLarkID("oc_keyed_b_")
	api.chats[chatA] = lark.InviteChat{ChatID: chatA, Name: "群 A"}
	api.chats[chatB] = lark.InviteChat{ChatID: chatB, Name: "群 B"}
	useFakeInviteAPI(t, api)
	cleanupLarkInvitesByTarget(t, chatA, chatB)

	key := uniqueLarkID("shared-")
	results := decodeLarkInviteResults(t, postLarkInvites(t, map[string]any{
		"chat_ids":         []string{chatA, chatB},
		"expires_in_hours": 168,
		"idempotency_key":  key,
	}, nil))

	if len(results) != 2 {
		t.Fatalf("results = %+v", results)
	}
	ids := map[string]string{}
	for _, res := range results {
		if res.Status != larkInviteSendStatusSent || res.ID == nil {
			t.Fatalf("result = %+v, want sent", res)
		}
		ids[res.Target.ID] = *res.ID
	}
	if ids[chatA] == ids[chatB] {
		t.Fatalf("two targets share invite id %s", ids[chatA])
	}
	if ids[chatA] != expectedKeyedInviteID(key, chatA) || ids[chatB] != expectedKeyedInviteID(key, chatB) {
		t.Fatalf("invite ids = %v, want derived per target", ids)
	}

	_, sends, _, _ := api.snapshot()
	if len(sends) != 2 || sends[0].DedupeKey == sends[1].DedupeKey {
		t.Fatalf("sends = %+v, want two sends with different dedupe keys", sends)
	}
}

func TestSendLarkInvites_NotConfigured(t *testing.T) {
	body := map[string]any{"chat_ids": []string{"oc_not_configured"}, "expires_in_hours": 168}

	t.Run("no invite api", func(t *testing.T) {
		useFakeInviteAPI(t, nil)

		assertLarkInviteError(t, postLarkInvites(t, body, nil), http.StatusForbidden, larkInviteCodeNotConfigured)
	})

	t.Run("seat capacity enabled", func(t *testing.T) {
		api := newFakeInviteAPI()
		useFakeInviteAPI(t, api)
		useSeatCapacity(t, seatcapacity.NewUnavailable(errors.New("seat capacity in test")))

		assertLarkInviteError(t, postLarkInvites(t, body, nil), http.StatusForbidden, larkInviteCodeNotConfigured)
		if calls, _, _, _ := api.snapshot(); calls != 0 {
			t.Fatalf("Feishu calls = %d, want 0", calls)
		}
	})
}

func TestGetLarkInviteStatus(t *testing.T) {
	status := func(t *testing.T) bool {
		t.Helper()

		w := httptest.NewRecorder()
		testHandler.GetLarkInviteStatus(w, newRequest(http.MethodGet, "/api/lark/status", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}

		var resp struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}

		return resp.Enabled
	}

	t.Run("configured", func(t *testing.T) {
		useFakeInviteAPI(t, newFakeInviteAPI())
		if !status(t) {
			t.Fatal("enabled = false, want true")
		}
	})

	t.Run("no invite api", func(t *testing.T) {
		useFakeInviteAPI(t, nil)
		if status(t) {
			t.Fatal("enabled = true, want false")
		}
	})

	t.Run("seat capacity enabled", func(t *testing.T) {
		useFakeInviteAPI(t, newFakeInviteAPI())
		useSeatCapacity(t, seatcapacity.NewUnavailable(errors.New("seat capacity in test")))
		if status(t) {
			t.Fatal("enabled = true, want false")
		}
	})
}

func TestSendLarkInvites_AgentRequiresAdminOriginator(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)

	agentID := createHandlerTestAgent(t, "Lark Invite Agent", nil)
	plainUser := dbfx.User(t, "Lark Plain Member", uniqueLarkEmail("plain"))
	dbfx.Member(t, testWorkspaceID, plainUser, "member")
	adminUser := dbfx.User(t, "Lark Admin Originator", uniqueLarkEmail("admin"))
	dbfx.Member(t, testWorkspaceID, adminUser, "admin")

	// 表约束要求 accountable_user_id 与 originator_user_id 一致。
	newTask := func(originator any) string {
		return dbfx.Task(t, agentID, testutil.Cols{
			"runtime_id":          handlerTestRuntimeID(t),
			"status":              "running",
			"started_at":          testutil.Raw("now()"),
			"originator_user_id":  originator,
			"accountable_user_id": originator,
		})
	}
	agentHeaders := func(taskID string) map[string]string {
		return map[string]string{"X-Agent-ID": agentID, "X-Task-ID": taskID}
	}

	t.Run("plain member originator", func(t *testing.T) {
		chatID := uniqueLarkID("oc_")
		api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "群"}
		cleanupLarkInvitesByTarget(t, chatID)

		headers := agentHeaders(newTask(plainUser))
		w := postLarkInvites(t, map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168}, headers)
		assertLarkInviteError(t, w, http.StatusForbidden, larkInviteCodePermissionDenied)

		req := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/lark-invites", nil), "id", testWorkspaceID)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		lw := httptest.NewRecorder()
		testHandler.ListLarkInvites(lw, req)
		assertLarkInviteError(t, lw, http.StatusForbidden, larkInviteCodePermissionDenied)
	})

	t.Run("no originator", func(t *testing.T) {
		chatID := uniqueLarkID("oc_")
		api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "群"}
		cleanupLarkInvitesByTarget(t, chatID)

		w := postLarkInvites(t, map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168}, agentHeaders(newTask(nil)))
		assertLarkInviteError(t, w, http.StatusForbidden, larkInviteCodePermissionDenied)
	})

	t.Run("admin originator", func(t *testing.T) {
		chatID := uniqueLarkID("oc_")
		api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "群"}
		cleanupLarkInvitesByTarget(t, chatID)

		w := postLarkInvites(t, map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 168}, agentHeaders(newTask(adminUser)))
		results := decodeLarkInviteResults(t, w)
		if len(results) != 1 || results[0].Status != larkInviteSendStatusSent {
			t.Fatalf("results = %s", w.Body.String())
		}

		row, ok := loadLarkInviteRow(t, chatID)
		if !ok {
			t.Fatal("invite row missing")
		}
		if row.SentByUserID != adminUser {
			t.Fatalf("sent_by_user_id = %s, want originator %s", row.SentByUserID, adminUser)
		}
		if row.SentByAgentID == nil || *row.SentByAgentID != agentID {
			t.Fatalf("sent_by_agent_id = %v, want %s", row.SentByAgentID, agentID)
		}

		_, sends, _, _ := api.snapshot()
		var card string
		for _, s := range sends {
			if s.ReceiveID == chatID {
				card = s.CardJSON
			}
		}
		if !strings.Contains(card, "Lark Invite Agent") || !strings.Contains(card, "Lark Admin Originator") {
			t.Fatalf("card does not name agent and originator: %s", card)
		}
	})
}

// listLarkInvitesForTest 调用列表接口，query 为空时不带 status。
func listLarkInvitesForTest(t *testing.T, query string) *httptest.ResponseRecorder {
	t.Helper()

	path := "/api/workspaces/" + testWorkspaceID + "/lark-invites"
	if query != "" {
		path += "?" + query
	}
	req := withURLParam(newRequest(http.MethodGet, path, nil), "id", testWorkspaceID)

	w := httptest.NewRecorder()
	testHandler.ListLarkInvites(w, req)

	return w
}

// decodeLarkInviteList 断言 200 并只保留 ids 里的邀请，保持响应顺序。
func decodeLarkInviteList(t *testing.T, w *httptest.ResponseRecorder, ids map[string]bool) []LarkInviteResponse {
	t.Helper()

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var all []LarkInviteResponse
	if err := json.Unmarshal(w.Body.Bytes(), &all); err != nil {
		t.Fatalf("decode list: %v, body = %s", err, w.Body.String())
	}

	var mine []LarkInviteResponse
	for _, inv := range all {
		if ids[inv.ID] {
			mine = append(mine, inv)
		}
	}

	return mine
}

func TestListLarkInvites_StatusFilter(t *testing.T) {
	useFakeInviteAPI(t, newFakeInviteAPI())
	ctx := context.Background()
	now := time.Now()

	active := createTestLarkInvite(t, newLarkInviteParams())

	completedParams := newLarkInviteParams()
	completedParams.MaxUses = pgtype.Int4{Int32: 1, Valid: true}
	completed := createTestLarkInvite(t, completedParams)
	dbfx.Exec(t, `UPDATE lark_invite SET use_count = 1 WHERE id = $1`, completed.ID)

	expiredParams := newLarkInviteParams()
	expiredParams.ExpiresAt = pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true}
	expired := createTestLarkInvite(t, expiredParams)

	revoked := createTestLarkInvite(t, newLarkInviteParams())
	if _, err := testHandler.Queries.RevokeLarkInvite(ctx, db.RevokeLarkInviteParams{ID: revoked.ID, WorkspaceID: revoked.WorkspaceID}); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	// 固定创建时间，倒序应为 revoked、expired、completed、active。
	for i, inv := range []db.LarkInvite{active, completed, expired, revoked} {
		dbfx.Exec(t, `UPDATE lark_invite SET created_at = $2 WHERE id = $1`, inv.ID, now.Add(time.Duration(i-10)*time.Minute))
	}

	if err := testHandler.Queries.CreateLarkInviteJoin(ctx, db.CreateLarkInviteJoinParams{
		InviteID:    active.ID,
		WorkspaceID: active.WorkspaceID,
		UserID:      parseUUID(testUserID),
		LarkOpenID:  "ou_list_join",
	}); err != nil {
		t.Fatalf("create join: %v", err)
	}

	ids := map[string]bool{}
	for _, inv := range []db.LarkInvite{active, completed, expired, revoked} {
		ids[uuidToString(inv.ID)] = true
	}

	t.Run("default is active only", func(t *testing.T) {
		w := listLarkInvitesForTest(t, "")
		var all []LarkInviteResponse
		if err := json.Unmarshal(w.Body.Bytes(), &all); err != nil {
			t.Fatalf("decode: %v", err)
		}
		for _, inv := range all {
			if inv.Status != larkInviteStatusActive {
				t.Fatalf("default list contains status %s", inv.Status)
			}
		}

		mine := decodeLarkInviteList(t, w, ids)
		if len(mine) != 1 || mine[0].ID != uuidToString(active.ID) {
			t.Fatalf("default list = %+v, want only the active invite", mine)
		}
		if mine[0].SentBy.ID != testUserID || mine[0].SentBy.Name != handlerTestName || mine[0].SentByAgent != nil {
			t.Fatalf("sent_by = %+v / %+v", mine[0].SentBy, mine[0].SentByAgent)
		}
		if len(mine[0].Joined) != 1 || mine[0].Joined[0].UserID != testUserID || mine[0].Joined[0].Email != handlerTestEmail {
			t.Fatalf("joined = %+v", mine[0].Joined)
		}
	})

	t.Run("all newest first", func(t *testing.T) {
		mine := decodeLarkInviteList(t, listLarkInvitesForTest(t, "status=all"), ids)

		want := []struct {
			id     pgtype.UUID
			status string
		}{
			{revoked.ID, larkInviteStatusRevoked},
			{expired.ID, larkInviteStatusExpired},
			{completed.ID, larkInviteStatusCompleted},
			{active.ID, larkInviteStatusActive},
		}
		if len(mine) != len(want) {
			t.Fatalf("all list = %+v", mine)
		}
		for i, wnt := range want {
			if mine[i].ID != uuidToString(wnt.id) || mine[i].Status != wnt.status {
				t.Fatalf("item %d = %s/%s, want %s/%s", i, mine[i].ID, mine[i].Status, uuidToString(wnt.id), wnt.status)
			}
		}
		if mine[0].RevokedAt == nil {
			t.Fatal("revoked invite has no revoked_at")
		}
	})

	t.Run("single status", func(t *testing.T) {
		mine := decodeLarkInviteList(t, listLarkInvitesForTest(t, "status=expired"), ids)
		if len(mine) != 1 || mine[0].ID != uuidToString(expired.ID) {
			t.Fatalf("expired list = %+v", mine)
		}
	})

	t.Run("unknown status", func(t *testing.T) {
		assertLarkInviteError(t, listLarkInvitesForTest(t, "status=bogus"), http.StatusBadRequest, larkInviteCodeInvalidRequest)
	})
}

func TestGetLarkInvite_ReturnsAllJoined(t *testing.T) {
	useFakeInviteAPI(t, newFakeInviteAPI())
	ctx := context.Background()

	inv := createTestLarkInvite(t, newLarkInviteParams())
	joinUsers := make([]string, 0, larkInviteListJoinedLimit+1)
	for i := 0; i <= larkInviteListJoinedLimit; i++ {
		joinUsers = append(joinUsers, dbfx.User(t, fmt.Sprintf("Joined %d", i), uniqueLarkEmail("joined")))
	}
	// 测试数据准备：每个用户一条加入记录。
	for _, userID := range joinUsers {
		if err := testHandler.Queries.CreateLarkInviteJoin(ctx, db.CreateLarkInviteJoinParams{
			InviteID:    inv.ID,
			WorkspaceID: inv.WorkspaceID,
			UserID:      parseUUID(userID),
			LarkOpenID:  "ou_" + userID,
		}); err != nil {
			t.Fatalf("create join: %v", err)
		}
	}

	ids := map[string]bool{uuidToString(inv.ID): true}
	listed := decodeLarkInviteList(t, listLarkInvitesForTest(t, ""), ids)
	if len(listed) != 1 || len(listed[0].Joined) != larkInviteListJoinedLimit {
		t.Fatalf("list joined = %+v, want %d", listed, larkInviteListJoinedLimit)
	}

	req := withURLParams(newRequest(http.MethodGet, "/", nil), "id", testWorkspaceID, "inviteId", uuidToString(inv.ID))
	w := httptest.NewRecorder()
	testHandler.GetLarkInvite(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var detail LarkInviteResponse
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(detail.Joined) != len(joinUsers) {
		t.Fatalf("detail joined = %d, want %d", len(detail.Joined), len(joinUsers))
	}

	missing := withURLParams(newRequest(http.MethodGet, "/", nil), "id", testWorkspaceID, "inviteId", "00000000-0000-0000-0000-000000000001")
	mw := httptest.NewRecorder()
	testHandler.GetLarkInvite(mw, missing)
	assertLarkInviteError(t, mw, http.StatusNotFound, larkInviteCodeInviteNotFound)
}

// revokeLarkInviteForTest 调用撤销接口。
func revokeLarkInviteForTest(t *testing.T, inviteID string) *httptest.ResponseRecorder {
	t.Helper()

	req := withURLParams(newRequest(http.MethodDelete, "/", nil), "id", testWorkspaceID, "inviteId", inviteID)
	w := httptest.NewRecorder()
	testHandler.RevokeLarkInvite(w, req)

	return w
}

func TestRevokeLarkInvite_PatchesCardAndIgnoresPatchError(t *testing.T) {
	api := newFakeInviteAPI()
	api.patchErr = errors.New("patch failed in test")
	useFakeInviteAPI(t, api)

	inv := createTestLarkInvite(t, newLarkInviteParams())
	messageID := uniqueLarkID("om_revoke_")
	if err := testHandler.Queries.SetLarkInviteMessageID(context.Background(), db.SetLarkInviteMessageIDParams{ID: inv.ID, LarkMessageID: strToText(messageID)}); err != nil {
		t.Fatalf("set message id: %v", err)
	}

	w := revokeLarkInviteForTest(t, uuidToString(inv.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp LarkInviteResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != larkInviteStatusRevoked || resp.RevokedAt == nil {
		t.Fatalf("response = %+v, want revoked", resp)
	}

	var revokedAt pgtype.Timestamptz
	dbfx.QueryRow(t, `SELECT revoked_at FROM lark_invite WHERE id = $1`, inv.ID).Scan(&revokedAt)
	if !revokedAt.Valid {
		t.Fatal("revoked_at not written")
	}

	_, _, patches, _ := api.snapshot()
	if len(patches) != 1 || patches[0].MessageID != messageID {
		t.Fatalf("patches = %+v, want one patch of %s", patches, messageID)
	}
	if !strings.Contains(patches[0].CardJSON, larkInviteReasonRevoked) || !strings.Contains(patches[0].CardJSON, larkInviteTitleInvalid) {
		t.Fatalf("patched card is not the revoked state: %s", patches[0].CardJSON)
	}

	// 再次撤销仍返回 200，不改写撤销时间，也不再更新卡片。
	again := revokeLarkInviteForTest(t, uuidToString(inv.ID))
	if again.Code != http.StatusOK {
		t.Fatalf("second revoke status = %d, body = %s", again.Code, again.Body.String())
	}
	if _, _, patches, _ := api.snapshot(); len(patches) != 1 {
		t.Fatalf("patches after second revoke = %d, want 1", len(patches))
	}

	assertLarkInviteError(t, revokeLarkInviteForTest(t, "00000000-0000-0000-0000-000000000002"), http.StatusNotFound, larkInviteCodeInviteNotFound)
}

// TestRevokeLarkInvite_PatchOutlivesRequest 确认撤销后的卡片更新不跟随请求取消：客户端在更新前断开，
// 更新照常带着自己的时限完成，卡片不会停在有效状态。
func TestRevokeLarkInvite_PatchOutlivesRequest(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)

	inv := createTestLarkInvite(t, newLarkInviteParams())
	messageID := uniqueLarkID("om_revoke_cancel_")
	if err := testHandler.Queries.SetLarkInviteMessageID(context.Background(), db.SetLarkInviteMessageIDParams{ID: inv.ID, LarkMessageID: strToText(messageID)}); err != nil {
		t.Fatalf("set message id: %v", err)
	}

	// 撤销已写入、卡片更新发出之前，客户端断开。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api.onPatch = cancel

	req := newRequest(http.MethodDelete, "/", nil).WithContext(ctx)
	req = withURLParams(req, "id", testWorkspaceID, "inviteId", uuidToString(inv.ID))
	testHandler.RevokeLarkInvite(httptest.NewRecorder(), req)

	_, _, patches, _ := api.snapshot()
	if len(patches) != 1 || patches[0].MessageID != messageID {
		t.Fatalf("patches = %+v, want one patch of %s", patches, messageID)
	}
	if patches[0].CtxErr != nil || !patches[0].HasDeadline {
		t.Fatalf("patch ctx err=%v deadline=%v, want a live context with its own timeout", patches[0].CtxErr, patches[0].HasDeadline)
	}
	if !strings.Contains(patches[0].CardJSON, larkInviteReasonRevoked) {
		t.Fatalf("patched card is not the revoked state: %s", patches[0].CardJSON)
	}
}

func TestLarkInviteWelcome_OnceAndAck(t *testing.T) {
	inv := createTestLarkInvite(t, newLarkInviteParams())
	if err := testHandler.Queries.CreateLarkInviteJoin(context.Background(), db.CreateLarkInviteJoinParams{
		InviteID:    inv.ID,
		WorkspaceID: inv.WorkspaceID,
		UserID:      parseUUID(testUserID),
		LarkOpenID:  "ou_welcome_test",
	}); err != nil {
		t.Fatalf("create join: %v", err)
	}

	get := func(t *testing.T) *httptest.ResponseRecorder {
		t.Helper()

		w := httptest.NewRecorder()
		testHandler.GetLarkInviteWelcome(w, withURLParam(newRequest(http.MethodGet, "/", nil), "id", testWorkspaceID))

		return w
	}

	first := get(t)
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", first.Code, first.Body.String())
	}
	var welcome struct {
		InviteID    string `json:"invite_id"`
		InviterName string `json:"inviter_name"`
		Role        string `json:"role"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &welcome); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if welcome.InviteID != uuidToString(inv.ID) || welcome.InviterName != handlerTestName || welcome.Role != larkInviteRoleMember {
		t.Fatalf("welcome = %+v", welcome)
	}

	ack := httptest.NewRecorder()
	testHandler.AckLarkInviteWelcome(ack, withURLParam(newRequest(http.MethodPost, "/", nil), "id", testWorkspaceID))
	if ack.Code != http.StatusNoContent {
		t.Fatalf("ack status = %d, body = %s", ack.Code, ack.Body.String())
	}

	if again := get(t); again.Code != http.StatusNoContent {
		t.Fatalf("status after ack = %d, body = %s", again.Code, again.Body.String())
	}
}

func TestLookupLarkUser(t *testing.T) {
	api := newFakeInviteAPI()
	email := uniqueLarkEmail("lookup")
	openID := uniqueLarkID("ou_")
	api.emails[email] = openID
	api.users[openID] = lark.InviteUser{OpenID: openID, Name: "王五", AvatarURL: "https://example.com/w.png"}
	useFakeInviteAPI(t, api)

	lookup := func(t *testing.T, query string) *httptest.ResponseRecorder {
		t.Helper()

		req := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/lark/users/lookup?"+query, nil), "id", testWorkspaceID)
		w := httptest.NewRecorder()
		testHandler.LookupLarkUser(w, req)

		return w
	}

	t.Run("found", func(t *testing.T) {
		w := lookup(t, "email="+email)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		assertJSONEqual(t, w.Body.Bytes(), fmt.Sprintf(`{"open_id":%q,"name":"王五","avatar_url":"https://example.com/w.png","email":%q}`, openID, email))
	})

	t.Run("not found", func(t *testing.T) {
		assertLarkInviteError(t, lookup(t, "email="+uniqueLarkEmail("missing")), http.StatusNotFound, lark.InviteErrUserNotFound)
	})

	t.Run("malformed email", func(t *testing.T) {
		assertLarkInviteError(t, lookup(t, "email=nope"), http.StatusBadRequest, larkInviteCodeInvalidTarget)
	})
}

func TestListLarkChats(t *testing.T) {
	api := newFakeInviteAPI()
	api.botChats = []lark.InviteChat{
		{ChatID: "oc_list_1", Name: "群一", AvatarURL: "https://example.com/1.png"},
		{ChatID: "oc_list_2", Name: "群二"},
	}
	useFakeInviteAPI(t, api)

	req := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/lark/chats", nil), "id", testWorkspaceID)
	w := httptest.NewRecorder()
	testHandler.ListLarkChats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	assertJSONEqual(t, w.Body.Bytes(), `[
		{"chat_id":"oc_list_1","name":"群一","avatar_url":"https://example.com/1.png","member_count":0},
		{"chat_id":"oc_list_2","name":"群二","avatar_url":null,"member_count":0}
	]`)
}

func TestLarkInviteStatusAndInvalidReason(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	future := pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true}
	// 北京时间 10 月 20 日 09:00。
	past := pgtype.Timestamptz{Time: time.Date(2026, 10, 20, 1, 0, 0, 0, time.UTC), Valid: true}

	cases := []struct {
		name   string
		inv    db.LarkInvite
		status string
		reason string
	}{
		{name: "active", inv: db.LarkInvite{ExpiresAt: future}, status: larkInviteStatusActive, reason: ""},
		{name: "completed", inv: db.LarkInvite{ExpiresAt: future, MaxUses: pgtype.Int4{Int32: 2, Valid: true}, UseCount: 2}, status: larkInviteStatusCompleted, reason: ""},
		{name: "expired beats completed", inv: db.LarkInvite{ExpiresAt: past, MaxUses: pgtype.Int4{Int32: 1, Valid: true}, UseCount: 1}, status: larkInviteStatusExpired, reason: "10 月 20 日 09:00 已过期"},
		{name: "revoked beats expired", inv: db.LarkInvite{ExpiresAt: past, RevokedAt: pgtype.Timestamptz{Time: now, Valid: true}}, status: larkInviteStatusRevoked, reason: larkInviteReasonRevoked},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := larkInviteStatus(tc.inv, now); got != tc.status {
				t.Fatalf("status = %s, want %s", got, tc.status)
			}
			if got := larkInviteInvalidReason(tc.inv, now); got != tc.reason {
				t.Fatalf("reason = %q, want %q", got, tc.reason)
			}
		})
	}
}

// larkInviteConfigCases 是应用配置类错误的两种原因：飞书错误码、期望的英文说明。
var larkInviteConfigCases = []struct {
	name    string
	code    int
	message string
}{
	{name: "bot ability off", code: fakeLarkCodeBotNotActivated, message: larkInviteMsgBotNotEnabled},
	{name: "scope missing", code: fakeLarkCodeScopeMissing, message: larkInviteMsgScopeMissing},
}

// assertLarkInviteConfigResponse 断言单个错误的接口响应：403、lark_not_configured、按原因区分的说明。
func assertLarkInviteConfigResponse(t *testing.T, w *httptest.ResponseRecorder, wantMessage string) {
	t.Helper()

	assertLarkInviteError(t, w, http.StatusForbidden, larkInviteCodeNotConfigured)

	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v, body = %s", err, w.Body.String())
	}
	if body["error"] != wantMessage {
		t.Fatalf("message = %q, want %q", body["error"], wantMessage)
	}
}

// assertLarkInviteConfigLogged 断言配置类错误按 Warn 记录，没有 Error 级别的日志。
func assertLarkInviteConfigLogged(t *testing.T, logs *larkInviteLogBuffer) {
	t.Helper()

	got := logs.String()
	if !strings.Contains(got, "level=WARN") {
		t.Fatalf("config error not logged at warn; log was:\n%s", got)
	}
	if strings.Contains(got, "level=ERROR") {
		t.Fatalf("config error logged as an error; log was:\n%s", got)
	}
}

// TestListLarkChats_FeishuErrors 列群失败时：应用配置类错误（232025、99991672）与开关关闭同为 403 lark_not_configured，
// 按 Warn 记录；其余飞书错误仍是 502。
func TestListLarkChats_FeishuErrors(t *testing.T) {
	list := func(t *testing.T, listErr error) *httptest.ResponseRecorder {
		t.Helper()

		api := newFakeInviteAPI()
		api.listChatsErr = listErr
		useFakeInviteAPI(t, api)

		req := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/lark/chats", nil), "id", testWorkspaceID)
		w := httptest.NewRecorder()
		testHandler.ListLarkChats(w, req)

		return w
	}

	for _, tc := range larkInviteConfigCases {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLarkInviteLogs(t)

			w := list(t, fmt.Errorf("list bot chats: %w", &lark.APIError{Op: "list bot chats", Code: tc.code, Msg: "feishu says no"}))

			assertLarkInviteConfigResponse(t, w, tc.message)
			assertLarkInviteConfigLogged(t, logs)
		})
	}

	t.Run("other feishu error stays 502", func(t *testing.T) {
		w := list(t, &lark.APIError{Op: "list bot chats", Code: fakeLarkCodeUnmapped, Msg: "other"})

		if w.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502, body = %s", w.Code, w.Body.String())
		}
	})
}

// TestLookupLarkUser_FeishuErrors 按邮箱查人失败时：应用配置类错误是 403 lark_not_configured（按 Warn 记录），
// 找不到用户仍是 404 user_not_found，其余飞书错误仍是 502。
func TestLookupLarkUser_FeishuErrors(t *testing.T) {
	lookup := func(t *testing.T, getUserErr error) *httptest.ResponseRecorder {
		t.Helper()

		api := newFakeInviteAPI()
		email := uniqueLarkEmail("lookup-err")
		openID := uniqueLarkID("ou_")
		api.emails[email] = openID
		api.users[openID] = lark.InviteUser{OpenID: openID, Name: "赵六"}
		api.getUserErr = getUserErr
		useFakeInviteAPI(t, api)

		req := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/lark/users/lookup?email="+email, nil), "id", testWorkspaceID)
		w := httptest.NewRecorder()
		testHandler.LookupLarkUser(w, req)

		return w
	}

	for _, tc := range larkInviteConfigCases {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLarkInviteLogs(t)

			w := lookup(t, fmt.Errorf("get user: %w", &lark.APIError{Op: "get user", Code: tc.code, Msg: "feishu says no"}))

			assertLarkInviteConfigResponse(t, w, tc.message)
			assertLarkInviteConfigLogged(t, logs)
		})
	}

	t.Run("user id invalid stays 404", func(t *testing.T) {
		w := lookup(t, &lark.APIError{Op: "get user", Code: fakeLarkCodeUserIDInvalid, Msg: "invalid user id"})

		assertLarkInviteError(t, w, http.StatusNotFound, lark.InviteErrUserNotFound)
	})

	t.Run("other feishu error stays 502", func(t *testing.T) {
		w := lookup(t, &lark.APIError{Op: "get user", Code: fakeLarkCodeUnmapped, Msg: "other"})

		if w.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502, body = %s", w.Code, w.Body.String())
		}
	})
}

// TestSendLarkInvites_ConfigErrorBecomesNotConfigured 发送时的应用配置类错误是这个接收方的失败结果，
// 错误码 lark_not_configured、说明按原因区分，按 Warn 记录；没发出的邀请行删除，带幂等键时也一样。
func TestSendLarkInvites_ConfigErrorBecomesNotConfigured(t *testing.T) {
	for _, tc := range larkInviteConfigCases {
		t.Run(tc.name+" from get user", func(t *testing.T) {
			logs := captureLarkInviteLogs(t)
			api := newFakeInviteAPI()
			email := uniqueLarkEmail("config")
			openID := uniqueLarkID("ou_")
			api.emails[email] = openID
			api.getUserErr = fmt.Errorf("get user: %w", &lark.APIError{Op: "get user", Code: tc.code, Msg: "feishu says no"})
			useFakeInviteAPI(t, api)
			cleanupLarkInvitesByTarget(t, email)

			results := decodeLarkInviteResults(t, postLarkInvites(t, map[string]any{
				"user_emails":      []string{email},
				"expires_in_hours": 72,
			}, nil))

			if len(results) != 1 || results[0].Status != larkInviteSendStatusFailed || results[0].Error == nil {
				t.Fatalf("results = %+v, want one failed result", results)
			}
			if got := *results[0].Error; got.Code != larkInviteCodeNotConfigured || got.Message != tc.message {
				t.Fatalf("error = %+v, want %s / %q", got, larkInviteCodeNotConfigured, tc.message)
			}
			if _, ok := loadLarkInviteRow(t, email); ok {
				t.Fatal("failed target has an invite row")
			}
			assertLarkInviteConfigLogged(t, logs)
		})

		t.Run(tc.name+" from send with key deletes the row", func(t *testing.T) {
			api := newFakeInviteAPI()
			chatID := uniqueLarkID("oc_config_")
			api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "配置群"}
			api.setSendErr(chatID, &lark.APIError{Op: "send invite card", Code: tc.code, Msg: "feishu says no"})
			useFakeInviteAPI(t, api)
			cleanupLarkInvitesByTarget(t, chatID)

			results := decodeLarkInviteResults(t, postLarkInvites(t, map[string]any{
				"chat_ids":         []string{chatID},
				"expires_in_hours": 72,
				"idempotency_key":  uniqueLarkID("config-"),
			}, nil))

			if len(results) != 1 || results[0].Status != larkInviteSendStatusFailed || results[0].Error == nil {
				t.Fatalf("results = %+v, want one failed result", results)
			}
			if got := *results[0].Error; got.Code != larkInviteCodeNotConfigured || got.Message != tc.message {
				t.Fatalf("error = %+v, want %s / %q", got, larkInviteCodeNotConfigured, tc.message)
			}
			if _, ok := loadLarkInviteRow(t, chatID); ok {
				t.Fatal("classified config error with a key kept the invite row")
			}
		})
	}
}

// TestSendLarkInvites_UnclassifiedSendFailureMessages 归不进分类的发送错误不再回显 err.Error()：
// 飞书接口错误只带错误码和飞书返回的 msg，其余错误用固定文案；完整错误只在 Warn 日志里。
func TestSendLarkInvites_UnclassifiedSendFailureMessages(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
		// leaked 是不应出现在响应里的原始错误片段。
		leaked []string
		// logged 是 Warn 日志里应有的完整错误片段。
		logged string
	}{
		{
			name:   "feishu api error",
			err:    fmt.Errorf("send lark invite card: %w", &lark.APIError{Op: "send invite card", Code: fakeLarkCodeUnmapped, Msg: "Invalid card content"}),
			want:   fmt.Sprintf("Feishu API error %d: Invalid card content", fakeLarkCodeUnmapped),
			leaked: []string{"lark http client", "code=", "send lark invite card"},
			logged: "lark http client: send invite card",
		},
		{
			name:   "network error",
			err:    errors.New("Post \"https://open.feishu.cn/open-apis/im/v1/messages\": dial tcp 10.1.2.3:443: connect: connection refused"),
			want:   larkInviteMsgSendFailed,
			leaked: []string{"dial tcp", "10.1.2.3", "open-apis"},
			logged: "dial tcp 10.1.2.3:443",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLarkInviteLogs(t)
			api := newFakeInviteAPI()
			chatID := uniqueLarkID("oc_unclassified_")
			api.chats[chatID] = lark.InviteChat{ChatID: chatID, Name: "失败群"}
			api.setSendErr(chatID, tc.err)
			useFakeInviteAPI(t, api)
			cleanupLarkInvitesByTarget(t, chatID)

			w := postLarkInvites(t, map[string]any{"chat_ids": []string{chatID}, "expires_in_hours": 72}, nil)
			results := decodeLarkInviteResults(t, w)

			if len(results) != 1 || results[0].Error == nil {
				t.Fatalf("results = %+v, want one failed result", results)
			}
			if got := *results[0].Error; got.Code != larkInviteCodeSendFailed || got.Message != tc.want {
				t.Fatalf("error = %+v, want %s / %q", got, larkInviteCodeSendFailed, tc.want)
			}
			for _, part := range tc.leaked {
				if strings.Contains(w.Body.String(), part) {
					t.Fatalf("response leaks %q: %s", part, w.Body.String())
				}
			}

			got := logs.String()
			if !strings.Contains(got, "level=WARN") || !strings.Contains(got, tc.logged) {
				t.Fatalf("log missing the full error %q; log was:\n%s", tc.logged, got)
			}
		})
	}
}

// TestLarkInviteConfigMessagesComplete 确认每个应用配置类错误的原因都有非空的英文说明，
// 新增原因时漏写说明会让响应里的 message 为空。
func TestLarkInviteConfigMessagesComplete(t *testing.T) {
	causes := lark.InviteConfigCauses()
	for _, exported := range []string{lark.InviteConfigBotNotEnabled, lark.InviteConfigScopeMissing} {
		if !slices.Contains(causes, exported) {
			t.Errorf("lark.InviteConfigCauses() = %v, missing %q", causes, exported)
		}
	}

	for _, cause := range causes {
		if strings.TrimSpace(larkInviteConfigMessages[cause]) == "" {
			t.Errorf("config cause %q has no message in larkInviteConfigMessages", cause)
		}
	}
	if len(larkInviteConfigMessages) != len(causes) {
		t.Errorf("larkInviteConfigMessages has %d entries, want %d (one per cause)", len(larkInviteConfigMessages), len(causes))
	}
}

// TestLarkInviteUnclassifiedMessage 覆盖说明的边界：飞书没返回 msg 时只带错误码，非飞书错误用固定文案。
func TestLarkInviteUnclassifiedMessage(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "with msg", err: &lark.APIError{Code: fakeLarkCodeUnmapped, Msg: "bad card"}, want: "Feishu API error 230099: bad card"},
		{name: "without msg", err: &lark.APIError{Code: fakeLarkCodeUnmapped}, want: "Feishu API error 230099"},
		{name: "plain error", err: errors.New("boom"), want: larkInviteMsgSendFailed},
		{name: "database error", err: errors.New("create lark invite: connection reset"), want: larkInviteMsgSendFailed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := larkInviteUnclassifiedMessage(tc.err); got != tc.want {
				t.Errorf("larkInviteUnclassifiedMessage = %q, want %q", got, tc.want)
			}
		})
	}
}
