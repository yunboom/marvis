package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/integrations/lark"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const (
	// larkInviteActionWorkspaceName 是点击测试里工作区的名字。
	larkInviteActionWorkspaceName = "Dev"
	// larkInviteActionTenant 是点击人的组织。
	larkInviteActionTenant = "t_ok"
	// larkInviteActionCallbackMessageID 是回调里被点击的消息 ID。
	larkInviteActionCallbackMessageID = "om_callback_test"
	// larkInviteActionHandlerTimeout 与长连接给卡片回调的处理时长一致。
	larkInviteActionHandlerTimeout = 2500 * time.Millisecond
	// larkInviteActionPatchWait 是等待异步卡片更新的上限。
	larkInviteActionPatchWait = 5 * time.Second
)

// 测试里点击后的提示文案，按工作区名 Dev 展开。
var (
	larkInviteActionJoinedToast        = fmt.Sprintf(larkInviteMsgJoinedFormat, larkInviteActionWorkspaceName)
	larkInviteActionAlreadyMemberToast = fmt.Sprintf(larkInviteMsgAlreadyMemberFormat, larkInviteActionWorkspaceName)
)

// buildLarkInviteCardAction 构造飞书 card.action.trigger 回调（schema 2.0），点击的是 inviteID 的“加入工作区”按钮。
func buildLarkInviteCardAction(t *testing.T, inviteID, openID, tenantKey string) []byte {
	t.Helper()

	return marshalLarkInviteCardAction(t, map[string]any{
		"action":    larkInviteActionJoin,
		"invite_id": inviteID,
	}, openID, tenantKey)
}

// marshalLarkInviteCardAction 按给定的按钮回传值构造回调 JSON。
func marshalLarkInviteCardAction(t *testing.T, value map[string]any, openID, tenantKey string) []byte {
	t.Helper()

	payload := map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"event_id":   uniqueLarkID("ev_"),
			"event_type": "card.action.trigger",
			"tenant_key": tenantKey,
			"app_id":     "cli_lark_invite_test",
			"token":      "verification-token",
		},
		"event": map[string]any{
			"operator": map[string]any{
				"open_id":    openID,
				"union_id":   "on_" + openID,
				"user_id":    "u_" + openID,
				"tenant_key": tenantKey,
			},
			"token":  "c-callback-token",
			"action": map[string]any{"tag": "button", "value": value},
			"host":   "im_message",
			"context": map[string]any{
				"open_message_id": larkInviteActionCallbackMessageID,
				"open_chat_id":    "oc_callback_test",
			},
		},
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal card action: %v", err)
	}

	return raw
}

// invokeLarkInviteAction 以长连接相同的时限调用回调处理函数并解析回应；回调结束后立即取消 context。
func invokeLarkInviteAction(payload []byte) (larkInviteCallbackResponse, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), larkInviteActionHandlerTimeout)
	defer cancel()

	raw, err := testHandler.HandleLarkInviteCardAction(ctx, payload)
	if err != nil {
		return larkInviteCallbackResponse{}, raw, err
	}

	var resp larkInviteCallbackResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return larkInviteCallbackResponse{}, raw, fmt.Errorf("decode card action response %s: %w", raw, err)
	}

	return resp, raw, nil
}

// clickLarkInvite 让 openID 点击邀请卡片并返回回应。
func clickLarkInvite(t *testing.T, inviteID, openID, tenantKey string) larkInviteCallbackResponse {
	t.Helper()

	resp, raw, err := invokeLarkInviteAction(buildLarkInviteCardAction(t, inviteID, openID, tenantKey))
	if err != nil {
		t.Fatalf("card action: %v, raw = %s", err, raw)
	}

	return resp
}

// assertLarkInviteToast 断言回应的提示类型和文案。
func assertLarkInviteToast(t *testing.T, resp larkInviteCallbackResponse, kind, content string) {
	t.Helper()

	if resp.Toast.Type != kind || resp.Toast.Content != content {
		t.Fatalf("toast = %+v, want %s %q", resp.Toast, kind, content)
	}
}

// newLarkInviteActionWorkspace 创建名为 Dev 的工作区，testUserID 是所有者。
func newLarkInviteActionWorkspace(t *testing.T) pgtype.UUID {
	t.Helper()

	slug := fmt.Sprintf("lark-invite-action-%d-%d", time.Now().UnixNano(), testSeq.Add(1))
	wsID := dbfx.Workspace(t, larkInviteActionWorkspaceName, slug)
	dbfx.Member(t, wsID, testUserID, larkInviteRoleOwner)

	return parseUUID(wsID)
}

// newLarkInviteActionInvite 在工作区里创建一张已发出的邀请（记下了消息 ID），mutate 可覆盖默认的群卡片参数。
func newLarkInviteActionInvite(t *testing.T, workspaceID pgtype.UUID, mutate func(*db.CreateLarkInviteParams)) db.LarkInvite {
	t.Helper()

	params := newLarkInviteParams()
	params.WorkspaceID = workspaceID
	if mutate != nil {
		mutate(&params)
	}
	inv := createTestLarkInvite(t, params)

	messageID := uniqueLarkID("om_action_")
	if err := testHandler.Queries.SetLarkInviteMessageID(context.Background(), db.SetLarkInviteMessageIDParams{ID: inv.ID, LarkMessageID: strToText(messageID)}); err != nil {
		t.Fatalf("set message id: %v", err)
	}
	inv.LarkMessageID = strToText(messageID)

	return inv
}

// asUserInvite 把邀请改成发给 openID 的个人卡片。
func asUserInvite(openID string) func(*db.CreateLarkInviteParams) {
	return func(p *db.CreateLarkInviteParams) {
		p.TargetType = larkInviteTargetUser
		p.TargetID = openID
		p.TargetIDType = larkInviteIDTypeOpenID
		p.TargetOpenID = strToText(openID)
		p.TargetName = "受邀人"
		p.MaxUses = pgtype.Int4{Int32: larkInviteUserMaxUses, Valid: true}
	}
}

// addLarkInviteClicker 在飞书接口桩里登记一个点击人，并在测试结束时删除点击可能新建的账号。
func addLarkInviteClicker(t *testing.T, api *fakeInviteAPI, name string) (openID, email string) {
	t.Helper()

	openID = uniqueLarkID("ou_")
	email = uniqueLarkEmail(name)
	api.users[openID] = lark.InviteUser{
		OpenID:    openID,
		Name:      "飞书 " + name,
		AvatarURL: "https://example.com/" + name + ".png",
		Email:     email,
	}
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1`, email)

	return openID, email
}

// larkInviteActionUser 是按邮箱读取的账号。
type larkInviteActionUser struct {
	ID        string
	Name      string
	AvatarURL *string
}

// loadLarkInviteActionUser 按邮箱读取账号，没有时返回 false。
func loadLarkInviteActionUser(t *testing.T, email string) (larkInviteActionUser, bool) {
	t.Helper()

	var u larkInviteActionUser
	err := testPool.QueryRow(context.Background(), `SELECT id::text, name, avatar_url FROM "user" WHERE email = $1`, email).Scan(&u.ID, &u.Name, &u.AvatarURL)
	if isNotFound(err) {
		return larkInviteActionUser{}, false
	}
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	return u, true
}

// countLarkInviteMembers 返回工作区里通过邮箱 email 对应账号的成员数。
func countLarkInviteMembers(t *testing.T, workspaceID pgtype.UUID, email string) int {
	t.Helper()

	return dbfx.Count(t, `
		SELECT count(*) FROM member m JOIN "user" u ON u.id = m.user_id
		WHERE m.workspace_id = $1 AND u.email = $2
	`, workspaceID, email)
}

// larkInviteUseCount 返回邀请当前的 use_count。
func larkInviteUseCount(t *testing.T, inviteID pgtype.UUID) int {
	t.Helper()

	var n int
	dbfx.QueryRow(t, `SELECT use_count FROM lark_invite WHERE id = $1`, inviteID).Scan(&n)

	return n
}

// waitForInvitePatches 轮询桩记录的卡片更新，直到至少有 n 次，最多等 larkInviteActionPatchWait。
// 卡片更新在回应之后异步执行，不能在回调返回时立即断言。
func waitForInvitePatches(t *testing.T, api *fakeInviteAPI, n int) []fakeInvitePatch {
	t.Helper()

	deadline := time.Now().Add(larkInviteActionPatchWait)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		_, _, patches, _ := api.snapshot()
		if len(patches) >= n {
			return patches
		}
		if time.Now().After(deadline) {
			t.Fatalf("patches = %d after %s, want %d", len(patches), larkInviteActionPatchWait, n)
		}
		<-ticker.C
	}
}

// clickLarkInviteConcurrently 同时放行全部点击，尽量让各自的事务重叠，返回每次点击的提示。
func clickLarkInviteConcurrently(t *testing.T, payloads ...[]byte) []larkInviteToast {
	t.Helper()

	var wg sync.WaitGroup
	start := make(chan struct{})
	toasts := make([]larkInviteToast, len(payloads))
	errs := make([]error, len(payloads))
	for i, payload := range payloads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp, raw, err := invokeLarkInviteAction(payload)
			if err != nil {
				errs[i] = fmt.Errorf("%w, raw = %s", err, raw)
				return
			}
			toasts[i] = resp.Toast
		}()
	}
	close(start)
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			t.Fatalf("card action: %v", err)
		}
	}

	return toasts
}

// countLarkInviteToasts 按文案统计提示次数。
func countLarkInviteToasts(toasts []larkInviteToast) map[string]int {
	counts := map[string]int{}
	for _, toast := range toasts {
		counts[toast.Content]++
	}

	return counts
}

// assertNoInvitePatches 断言没有更新卡片。
func assertNoInvitePatches(t *testing.T, api *fakeInviteAPI) {
	t.Helper()

	if _, _, patches, _ := api.snapshot(); len(patches) != 0 {
		t.Fatalf("patches = %+v, want none", patches)
	}
}

// decodeLarkInviteCardJSON 解析卡片 JSON，返回标题和卡片原始 JSON 文本，调用方用子串断言正文内容。
func decodeLarkInviteCardJSON(t *testing.T, raw []byte) (title, text string) {
	t.Helper()

	var card larkCard
	if err := json.Unmarshal(raw, &card); err != nil {
		t.Fatalf("decode card: %v, raw = %s", err, raw)
	}

	return card.Header.Title.Content, string(raw)
}

func TestLarkInviteAction_JoinsChatCard(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, func(p *db.CreateLarkInviteParams) {
		p.Role = larkInviteRoleAdmin
	})
	openID, email := addLarkInviteClicker(t, api, "newcomer")

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastSuccess, larkInviteActionJoinedToast)
	if resp.Card != nil {
		t.Fatalf("chat card response replaced the card: %+v", resp.Card)
	}

	user, ok := loadLarkInviteActionUser(t, email)
	if !ok {
		t.Fatal("account not created")
	}
	if user.Name != "飞书 newcomer" || user.AvatarURL == nil || *user.AvatarURL != "https://example.com/newcomer.png" {
		t.Fatalf("new account profile = %+v, want Feishu name and avatar", user)
	}

	var role string
	dbfx.QueryRow(t, `SELECT role FROM member WHERE workspace_id = $1 AND user_id = $2`, wsID, user.ID).Scan(&role)
	if role != larkInviteRoleAdmin {
		t.Fatalf("member role = %s, want %s", role, larkInviteRoleAdmin)
	}

	if n := larkInviteUseCount(t, inv.ID); n != 1 {
		t.Fatalf("use_count = %d, want 1", n)
	}
	var joinOpenID string
	dbfx.QueryRow(t, `SELECT lark_open_id FROM lark_invite_join WHERE invite_id = $1 AND user_id = $2`, inv.ID, user.ID).Scan(&joinOpenID)
	if joinOpenID != openID {
		t.Fatalf("join lark_open_id = %s, want %s", joinOpenID, openID)
	}

	patches := waitForInvitePatches(t, api, 1)
	if patches[0].MessageID != inv.LarkMessageID.String {
		t.Fatalf("patched message = %s, want %s", patches[0].MessageID, inv.LarkMessageID.String)
	}
	if !patches[0].HasDeadline || patches[0].CtxErr != nil {
		t.Fatalf("patch ctx deadline=%v err=%v, want own timeout and not canceled with the callback", patches[0].HasDeadline, patches[0].CtxErr)
	}
	title, text := decodeLarkInviteCardJSON(t, []byte(patches[0].CardJSON))
	if title != larkInviteTitleActive || !strings.Contains(text, fmt.Sprintf(larkInviteJoinedCountFormat, 1)) {
		t.Fatalf("patched card title = %q, want active card with joined count: %s", title, patches[0].CardJSON)
	}
}

// TestLarkInviteAction_RevokeDuringCountPatchEndsInvalid 覆盖撤销与点击的竞争：点击加入后异步改人数的更新
// 还在途中时管理员撤销了邀请，撤销的失效更新先到、人数更新后到。最终卡片必须是失效状态，不能被改回有效。
func TestLarkInviteAction_RevokeDuringCountPatchEndsInvalid(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, _ := addLarkInviteClicker(t, api, "race")

	// 只在第一次更新（点击后的人数更新）时插入撤销；撤销自己的卡片更新会再次进入这里，不能重入。
	var revoked atomic.Bool
	revokeStatus := make(chan int, 1)
	api.onPatch = func() {
		if !revoked.CompareAndSwap(false, true) {
			return
		}

		req := withURLParams(newRequest(http.MethodDelete, "/", nil), "id", uuidToString(wsID), "inviteId", uuidToString(inv.ID))
		w := httptest.NewRecorder()
		testHandler.RevokeLarkInvite(w, req)
		revokeStatus <- w.Code
	}

	assertLarkInviteToast(t, clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant), larkInviteToastSuccess, larkInviteActionJoinedToast)

	select {
	case code := <-revokeStatus:
		if code != http.StatusOK {
			t.Fatalf("revoke status = %d, want 200", code)
		}
	case <-time.After(larkInviteActionPatchWait):
		t.Fatal("count patch never started")
	}

	deadline := time.Now().Add(larkInviteActionPatchWait)
	for {
		_, _, patches, _ := api.snapshot()
		last := patches[len(patches)-1]
		title, _ := decodeLarkInviteCardJSON(t, []byte(last.CardJSON))
		if title == larkInviteTitleInvalid && strings.Contains(last.CardJSON, larkInviteReasonRevoked) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("last patch title = %q after a revoke, want the revoked card; patches = %d", title, len(patches))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestLarkInviteAction_CountPatchReadsLatestState 确认人数更新按邀请的最新状态生成卡片：点击回应之后、
// 更新开始之前邀请已被撤销，更新出去的是失效卡片，不会先出现一张有效卡片。
func TestLarkInviteAction_CountPatchReadsLatestState(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	dbfx.Exec(t, `UPDATE lark_invite SET use_count = 1 WHERE id = $1`, inv.ID)
	if _, err := testHandler.Queries.RevokeLarkInvite(context.Background(), db.RevokeLarkInviteParams{ID: inv.ID, WorkspaceID: wsID}); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	testHandler.patchLarkInviteCardAsync(context.Background(), inv.ID, inv.LarkMessageID.String, larkInviteCardNames{Workspace: larkInviteActionWorkspaceName})

	patches := waitForInvitePatches(t, api, 1)
	title, _ := decodeLarkInviteCardJSON(t, []byte(patches[0].CardJSON))
	if len(patches) != 1 || title != larkInviteTitleInvalid || !strings.Contains(patches[0].CardJSON, larkInviteReasonRevoked) {
		t.Fatalf("patches = %+v, want a single revoked card", patches)
	}
}

func TestLarkInviteAction_RejoinAfterRemoval(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, email := addLarkInviteClicker(t, api, "rejoin")

	assertLarkInviteToast(t, clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant), larkInviteToastSuccess, larkInviteActionJoinedToast)
	waitForInvitePatches(t, api, 1)

	// 移出工作区后再点同一张群卡片：重新加入，加入记录保持一条。
	user, _ := loadLarkInviteActionUser(t, email)
	dbfx.Exec(t, `DELETE FROM member WHERE workspace_id = $1 AND user_id = $2`, wsID, user.ID)

	assertLarkInviteToast(t, clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant), larkInviteToastSuccess, larkInviteActionJoinedToast)

	if n := countLarkInviteMembers(t, wsID, email); n != 1 {
		t.Fatalf("members after rejoin = %d, want 1", n)
	}
	if n := larkInviteUseCount(t, inv.ID); n != 2 {
		t.Fatalf("use_count after rejoin = %d, want 2", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM lark_invite_join WHERE invite_id = $1`, inv.ID); n != 1 {
		t.Fatalf("join rows after rejoin = %d, want 1", n)
	}

	patches := waitForInvitePatches(t, api, 2)
	if !strings.Contains(patches[1].CardJSON, fmt.Sprintf(larkInviteJoinedCountFormat, 2)) {
		t.Fatalf("second patch has no count 2: %s", patches[1].CardJSON)
	}
}

func TestLarkInviteAction_UserCardReplacesCard(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inviteeOpenID, inviteeEmail := addLarkInviteClicker(t, api, "invitee")
	otherOpenID, otherEmail := addLarkInviteClicker(t, api, "other")
	inv := newLarkInviteActionInvite(t, wsID, asUserInvite(inviteeOpenID))

	t.Run("someone else", func(t *testing.T) {
		resp := clickLarkInvite(t, uuidToString(inv.ID), otherOpenID, larkInviteActionTenant)

		assertLarkInviteToast(t, resp, larkInviteToastError, larkInviteMsgNotInvitee)
		if resp.Card != nil {
			t.Fatalf("rejected click replaced the card: %+v", resp.Card)
		}
		if _, ok := loadLarkInviteActionUser(t, otherEmail); ok {
			t.Fatal("account created for someone who is not the invitee")
		}
		if n := larkInviteUseCount(t, inv.ID); n != 0 {
			t.Fatalf("use_count = %d, want 0", n)
		}
	})

	t.Run("invitee", func(t *testing.T) {
		resp := clickLarkInvite(t, uuidToString(inv.ID), inviteeOpenID, larkInviteActionTenant)

		assertLarkInviteToast(t, resp, larkInviteToastSuccess, larkInviteActionJoinedToast)
		if resp.Card == nil || resp.Card.Type != larkCardResponseTypeRaw {
			t.Fatalf("card = %+v, want raw replacement card", resp.Card)
		}
		title, _ := decodeLarkInviteCardJSON(t, resp.Card.Data)
		if title != fmt.Sprintf(larkInviteTitleJoinedFormat, larkInviteActionWorkspaceName) {
			t.Fatalf("replacement card title = %q, want 已加入 Dev", title)
		}
		if n := countLarkInviteMembers(t, wsID, inviteeEmail); n != 1 {
			t.Fatalf("invitee members = %d, want 1", n)
		}
		if n := larkInviteUseCount(t, inv.ID); n != 1 {
			t.Fatalf("use_count = %d, want 1", n)
		}
	})

	// 长连接按顺序处理回调，连点两下时第二次看到的已是用完的卡片。
	t.Run("invitee clicks again", func(t *testing.T) {
		resp := clickLarkInvite(t, uuidToString(inv.ID), inviteeOpenID, larkInviteActionTenant)
		assertLarkInviteToast(t, resp, larkInviteToastInfo, larkInviteActionAlreadyMemberToast)
	})

	t.Run("someone else after it is used", func(t *testing.T) {
		resp := clickLarkInvite(t, uuidToString(inv.ID), otherOpenID, larkInviteActionTenant)
		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgFull)
	})

	assertNoInvitePatches(t, api)
}

func TestLarkInviteAction_DoubleClick(t *testing.T) {
	cases := []struct {
		name string
		user bool
	}{
		{name: "chat card"},
		{name: "user card", user: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := newFakeInviteAPI()
			useFakeInviteAPI(t, api)
			wsID := newLarkInviteActionWorkspace(t)
			openID, email := addLarkInviteClicker(t, api, "double")
			var mutate func(*db.CreateLarkInviteParams)
			if tc.user {
				mutate = asUserInvite(openID)
			}
			inv := newLarkInviteActionInvite(t, wsID, mutate)
			payload := buildLarkInviteCardAction(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

			toasts := clickLarkInviteConcurrently(t, payload, payload)

			counts := countLarkInviteToasts(toasts)
			if counts[larkInviteActionJoinedToast] != 1 || counts[larkInviteActionAlreadyMemberToast] != 1 {
				t.Fatalf("toasts = %+v, want one joined and one already a member", toasts)
			}

			if n := countLarkInviteMembers(t, wsID, email); n != 1 {
				t.Fatalf("members = %d, want 1", n)
			}
			if n := larkInviteUseCount(t, inv.ID); n != 1 {
				t.Fatalf("use_count = %d, want 1", n)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM lark_invite_join WHERE invite_id = $1`, inv.ID); n != 1 {
				t.Fatalf("join rows = %d, want 1", n)
			}

			if !tc.user {
				waitForInvitePatches(t, api, 1)
			}
		})
	}
}

func TestLarkInviteAction_ConcurrentClicksRespectMaxUses(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, func(p *db.CreateLarkInviteParams) {
		p.MaxUses = pgtype.Int4{Int32: 1, Valid: true}
	})
	firstOpenID, firstEmail := addLarkInviteClicker(t, api, "race-a")
	secondOpenID, secondEmail := addLarkInviteClicker(t, api, "race-b")

	// 两个人同时点击只有一个名额的群卡片。
	toasts := clickLarkInviteConcurrently(t,
		buildLarkInviteCardAction(t, uuidToString(inv.ID), firstOpenID, larkInviteActionTenant),
		buildLarkInviteCardAction(t, uuidToString(inv.ID), secondOpenID, larkInviteActionTenant),
	)

	counts := countLarkInviteToasts(toasts)
	if counts[larkInviteActionJoinedToast] != 1 || counts[larkInviteMsgFull] != 1 {
		t.Fatalf("toasts = %+v, want one joined and one full", toasts)
	}

	members := countLarkInviteMembers(t, wsID, firstEmail) + countLarkInviteMembers(t, wsID, secondEmail)
	if members != 1 {
		t.Fatalf("members = %d, want 1", members)
	}
	if n := larkInviteUseCount(t, inv.ID); n != 1 {
		t.Fatalf("use_count = %d, want 1", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM lark_invite_join WHERE invite_id = $1`, inv.ID); n != 1 {
		t.Fatalf("join rows = %d, want 1", n)
	}

	waitForInvitePatches(t, api, 1)
}

func TestLarkInviteAction_MissingInviteOrWorkspace(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	openID, email := addLarkInviteClicker(t, api, "missing")

	t.Run("unknown invite", func(t *testing.T) {
		resp := clickLarkInvite(t, "00000000-0000-0000-0000-0000000000f7", openID, larkInviteActionTenant)
		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
	})

	t.Run("malformed invite id", func(t *testing.T) {
		resp := clickLarkInvite(t, "not-a-uuid", openID, larkInviteActionTenant)
		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
	})

	t.Run("workspace deleted", func(t *testing.T) {
		wsID := dbfx.Workspace(t, larkInviteActionWorkspaceName, fmt.Sprintf("lark-invite-action-gone-%d-%d", time.Now().UnixNano(), testSeq.Add(1)))
		inv := newLarkInviteActionInvite(t, parseUUID(wsID), nil)
		dbfx.Exec(t, `DELETE FROM workspace WHERE id = $1`, wsID)

		resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)
		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
		if n := larkInviteUseCount(t, inv.ID); n != 0 {
			t.Fatalf("use_count = %d, want 0", n)
		}
	})

	if _, ok := loadLarkInviteActionUser(t, email); ok {
		t.Fatal("account created for an invalid invite")
	}
	assertNoInvitePatches(t, api)
}

func TestLarkInviteAction_SlowContactLookup(t *testing.T) {
	api := newFakeInviteAPI()
	api.blockGetUser = true
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, email := addLarkInviteClicker(t, api, "slow")

	started := time.Now()
	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)
	elapsed := time.Since(started)

	if elapsed >= larkInviteActionHandlerTimeout {
		t.Fatalf("handler took %s, want an answer within %s", elapsed, larkInviteActionHandlerTimeout)
	}
	assertLarkInviteToast(t, resp, larkInviteToastError, larkInviteMsgFailed)
	if n := countLarkInviteMembers(t, wsID, email); n != 0 {
		t.Fatalf("members = %d, want 0", n)
	}
	if n := larkInviteUseCount(t, inv.ID); n != 0 {
		t.Fatalf("use_count = %d, want 0", n)
	}
}

func TestLarkInviteAction_ExpiredRevokedFull(t *testing.T) {
	t.Run("expired", func(t *testing.T) {
		api := newFakeInviteAPI()
		useFakeInviteAPI(t, api)
		wsID := newLarkInviteActionWorkspace(t)
		inv := newLarkInviteActionInvite(t, wsID, func(p *db.CreateLarkInviteParams) {
			p.ExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true}
		})
		openID, email := addLarkInviteClicker(t, api, "expired")

		resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
		patches := waitForInvitePatches(t, api, 1)
		title, text := decodeLarkInviteCardJSON(t, []byte(patches[0].CardJSON))
		if patches[0].MessageID != inv.LarkMessageID.String || title != larkInviteTitleInvalid || !strings.Contains(text, larkInviteInvalidReason(inv, time.Now())) {
			t.Fatalf("patch = %+v, want invalid card with expiry reason", patches[0])
		}
		if _, ok := loadLarkInviteActionUser(t, email); ok {
			t.Fatal("account created for an expired invite")
		}
	})

	t.Run("revoked", func(t *testing.T) {
		api := newFakeInviteAPI()
		useFakeInviteAPI(t, api)
		wsID := newLarkInviteActionWorkspace(t)
		inv := newLarkInviteActionInvite(t, wsID, nil)
		if _, err := testHandler.Queries.RevokeLarkInvite(context.Background(), db.RevokeLarkInviteParams{ID: inv.ID, WorkspaceID: wsID}); err != nil {
			t.Fatalf("revoke: %v", err)
		}
		openID, _ := addLarkInviteClicker(t, api, "revoked")

		resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
		patches := waitForInvitePatches(t, api, 1)
		if !strings.Contains(patches[0].CardJSON, larkInviteReasonRevoked) || !strings.Contains(patches[0].CardJSON, larkInviteTitleInvalid) {
			t.Fatalf("patched card is not the revoked state: %s", patches[0].CardJSON)
		}
		if n := larkInviteUseCount(t, inv.ID); n != 0 {
			t.Fatalf("use_count = %d, want 0", n)
		}
	})

	t.Run("expired without stored message id patches the clicked message", func(t *testing.T) {
		api := newFakeInviteAPI()
		useFakeInviteAPI(t, api)
		wsID := newLarkInviteActionWorkspace(t)
		params := newLarkInviteParams()
		params.WorkspaceID = wsID
		params.ExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true}
		inv := createTestLarkInvite(t, params)
		openID, _ := addLarkInviteClicker(t, api, "nomsg")

		assertLarkInviteToast(t, clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant), larkInviteToastWarning, larkInviteMsgInvalid)
		if patches := waitForInvitePatches(t, api, 1); patches[0].MessageID != larkInviteActionCallbackMessageID {
			t.Fatalf("patched message = %s, want the clicked message %s", patches[0].MessageID, larkInviteActionCallbackMessageID)
		}
	})

	t.Run("full", func(t *testing.T) {
		api := newFakeInviteAPI()
		useFakeInviteAPI(t, api)
		wsID := newLarkInviteActionWorkspace(t)
		inv := newLarkInviteActionInvite(t, wsID, func(p *db.CreateLarkInviteParams) {
			p.MaxUses = pgtype.Int4{Int32: 1, Valid: true}
		})
		dbfx.Exec(t, `UPDATE lark_invite SET use_count = 1 WHERE id = $1`, inv.ID)
		openID, email := addLarkInviteClicker(t, api, "full")

		resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

		assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgFull)
		if n := larkInviteUseCount(t, inv.ID); n != 1 {
			t.Fatalf("use_count = %d, want 1", n)
		}
		if _, ok := loadLarkInviteActionUser(t, email); ok {
			t.Fatal("account created for a full invite")
		}
		assertNoInvitePatches(t, api)
	})
}

func TestLarkInviteAction_TenantNotAllowed(t *testing.T) {
	t.Setenv(larkLoginTenantKeysEnv, larkInviteActionTenant)
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, email := addLarkInviteClicker(t, api, "tenant")

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, "t_other")

	assertLarkInviteToast(t, resp, larkInviteToastError, larkInviteMsgTenantNotAllowed)
	if _, ok := loadLarkInviteActionUser(t, email); ok {
		t.Fatal("account created for a clicker outside the allowed tenants")
	}
	if n := larkInviteUseCount(t, inv.ID); n != 0 {
		t.Fatalf("use_count = %d, want 0", n)
	}

	// 同一个人从允许的组织点击可以加入。
	assertLarkInviteToast(t, clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant), larkInviteToastSuccess, larkInviteActionJoinedToast)
	waitForInvitePatches(t, api, 1)
}

// larkInviteActionDisabledEmail 在临时停用账号名单里（auth.IsTemporarilyDisabledUserEmail）。
const larkInviteActionDisabledEmail = "pdzzer68@embassybase.com"

// TestLarkInviteAction_ContactRejections 覆盖点击人的通讯录资料取不到或账号已停用：这些是确定性的拒绝，
// 回明确的提示而不是“稍后重试”，按 Warn 记日志，不占用名额。
func TestLarkInviteAction_ContactRejections(t *testing.T) {
	cases := []struct {
		name string
		// register 在接口桩里登记点击人，返回点击人的 open_id。
		register func(api *fakeInviteAPI) string
		want     string
	}{
		{
			name: "outside the app availability scope",
			register: func(api *fakeInviteAPI) string {
				api.getUserErr = &lark.APIError{Op: "get user", Code: fakeLarkCodeUserNotInScope, Msg: "no availability"}
				return uniqueLarkID("ou_scope_")
			},
			want: larkInviteMsgNotInAppScope,
		},
		{
			name: "user not found",
			register: func(*fakeInviteAPI) string {
				return uniqueLarkID("ou_missing_")
			},
			want: larkInviteMsgUserNotFound,
		},
		{
			// 飞书应用缺通讯录权限：点击人无从处理，回通用的失败提示，原因由 Warn 日志给管理员。
			name: "app missing contact scope",
			register: func(api *fakeInviteAPI) string {
				api.getUserErr = &lark.APIError{Op: "get user", Code: fakeLarkCodeScopeMissing, Msg: "Access denied"}
				return uniqueLarkID("ou_noscope_")
			},
			want: larkInviteMsgFailed,
		},
		{
			name: "account disabled",
			register: func(api *fakeInviteAPI) string {
				openID := uniqueLarkID("ou_disabled_")
				api.users[openID] = lark.InviteUser{OpenID: openID, Name: "停用账号", Email: larkInviteActionDisabledEmail}
				return openID
			},
			want: larkInviteMsgAccountDisabled,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := newFakeInviteAPI()
			useFakeInviteAPI(t, api)
			wsID := newLarkInviteActionWorkspace(t)
			inv := newLarkInviteActionInvite(t, wsID, nil)
			openID := tc.register(api)
			logs := captureLarkInviteLogs(t)

			resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

			assertLarkInviteToast(t, resp, larkInviteToastError, tc.want)
			if n := larkInviteUseCount(t, inv.ID); n != 0 {
				t.Fatalf("use_count = %d, want 0", n)
			}

			got := logs.String()
			if !strings.Contains(got, "level=WARN") || !strings.Contains(got, "lark invite card action rejected") {
				t.Fatalf("rejection not logged at warn; log was:\n%s", got)
			}
			if strings.Contains(got, "level=ERROR") {
				t.Fatalf("deterministic rejection logged as an error; log was:\n%s", got)
			}
		})
	}
}

func TestLarkInviteAction_NoEmail(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID := uniqueLarkID("ou_")
	api.users[openID] = lark.InviteUser{OpenID: openID, Name: "没有邮箱"}

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastError, larkInviteMsgNoEmail)
	if n := larkInviteUseCount(t, inv.ID); n != 0 {
		t.Fatalf("use_count = %d, want 0", n)
	}
}

func TestLarkInviteAction_UserEmail(t *testing.T) {
	cases := []struct {
		name string
		user lark.InviteUser
		want string
	}{
		{name: "email first", user: lark.InviteUser{Email: " Zhang@Example.com ", EnterpriseEmail: "z@corp.example"}, want: "zhang@example.com"},
		{name: "enterprise email fallback", user: lark.InviteUser{EnterpriseEmail: " Z@Corp.Example"}, want: "z@corp.example"},
		{name: "none", user: lark.InviteUser{}, want: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := larkInviteUserEmail(tc.user); got != tc.want {
				t.Fatalf("email = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLarkInviteAction_SignupProhibited(t *testing.T) {
	prev := testHandler.cfg
	testHandler.cfg.AllowSignup = false
	t.Cleanup(func() { testHandler.cfg = prev })

	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, email := addLarkInviteClicker(t, api, "nosignup")

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastError, larkInviteMsgSignupProhibited)
	if _, ok := loadLarkInviteActionUser(t, email); ok {
		t.Fatal("account created while signup is prohibited")
	}
	if n := larkInviteUseCount(t, inv.ID); n != 0 {
		t.Fatalf("use_count = %d, want 0", n)
	}
}

func TestLarkInviteAction_ExistingAccountKeepsProfile(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	inv := newLarkInviteActionInvite(t, wsID, nil)
	openID, email := addLarkInviteClicker(t, api, "existing")
	userID := dbfx.User(t, "Existing Name", email)

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastSuccess, larkInviteActionJoinedToast)
	user, _ := loadLarkInviteActionUser(t, email)
	if user.ID != userID || user.Name != "Existing Name" || user.AvatarURL != nil {
		t.Fatalf("existing account = %+v, want unchanged profile", user)
	}
	waitForInvitePatches(t, api, 1)

	// 已是成员时不占用名额。
	again := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)
	assertLarkInviteToast(t, again, larkInviteToastInfo, larkInviteActionAlreadyMemberToast)
	if n := larkInviteUseCount(t, inv.ID); n != 1 {
		t.Fatalf("use_count after second click = %d, want 1", n)
	}
}

func TestLarkInviteAction_SenderRemovedStillWorks(t *testing.T) {
	api := newFakeInviteAPI()
	useFakeInviteAPI(t, api)
	wsID := newLarkInviteActionWorkspace(t)
	senderID := dbfx.User(t, "Sender Person", uniqueLarkEmail("sender"))
	dbfx.Member(t, uuidToString(wsID), senderID, larkInviteRoleAdmin)
	inv := newLarkInviteActionInvite(t, wsID, func(p *db.CreateLarkInviteParams) {
		p.SentByUserID = parseUUID(senderID)
	})
	dbfx.Exec(t, `DELETE FROM member WHERE workspace_id = $1 AND user_id = $2`, wsID, senderID)
	openID, email := addLarkInviteClicker(t, api, "after-sender")

	resp := clickLarkInvite(t, uuidToString(inv.ID), openID, larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastSuccess, larkInviteActionJoinedToast)
	if n := countLarkInviteMembers(t, wsID, email); n != 1 {
		t.Fatalf("members = %d, want 1", n)
	}
	patches := waitForInvitePatches(t, api, 1)
	if !strings.Contains(patches[0].CardJSON, "Sender Person") {
		t.Fatalf("patched card lost the sender name: %s", patches[0].CardJSON)
	}
}

func TestLarkInviteAction_IgnoresOtherPayloads(t *testing.T) {
	useFakeInviteAPI(t, newFakeInviteAPI())

	cases := []struct {
		name    string
		payload []byte
	}{
		{name: "not json", payload: []byte("not json")},
		{name: "other action", payload: marshalLarkInviteCardAction(t, map[string]any{"action": "open_settings", "invite_id": "x"}, "ou_other_action", larkInviteActionTenant)},
		{name: "no operator", payload: buildLarkInviteCardAction(t, "00000000-0000-0000-0000-0000000000f8", "", larkInviteActionTenant)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := testHandler.HandleLarkInviteCardAction(context.Background(), tc.payload)
			if err != nil {
				t.Fatalf("card action: %v", err)
			}
			if string(raw) != larkInviteEmptyResponse {
				t.Fatalf("response = %s, want %s", raw, larkInviteEmptyResponse)
			}
		})
	}
}

func TestLarkInviteAction_NotConfigured(t *testing.T) {
	useFakeInviteAPI(t, nil)

	resp := clickLarkInvite(t, "00000000-0000-0000-0000-0000000000f9", "ou_not_configured", larkInviteActionTenant)

	assertLarkInviteToast(t, resp, larkInviteToastWarning, larkInviteMsgInvalid)
}
