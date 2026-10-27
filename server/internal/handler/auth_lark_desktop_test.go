package handler

import (
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"

	"github.com/yunboom/marvis/server/internal/auth"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const (
	// larkDesktopTestRedirectURI 是测试里通过环境变量配置的桌面端回调地址。
	larkDesktopTestRedirectURI = "http://studio.example:13840/auth/lark/desktop-callback"
	// larkDesktopTestCode 是飞书桩接受的授权码。
	larkDesktopTestCode = "desktop-code"
)

// larkDesktopTestNonce 是一个合法的 nonce，长度 40。
var larkDesktopTestNonce = strings.Repeat("aB3_-", 8)

// larkDesktopHrefPattern 取出成功页里“打开 Marvis”按钮的链接。
var larkDesktopHrefPattern = regexp.MustCompile(`href="([^"]+)"`)

// newLarkDesktopTestHandler 创建带 state 存储的测试 Handler，与 New 创建的一致。
func newLarkDesktopTestHandler(cfg Config) *Handler {
	h := newTestHandler(cfg)
	h.larkDesktopStates = &larkDesktopStateStore{}

	return h
}

// setLarkDesktopEnv 配置飞书登录与桌面端回调地址。
func setLarkDesktopEnv(t *testing.T, tenantKeys string) {
	t.Helper()

	setLarkLoginEnv(t, tenantKeys)
	t.Setenv(larkLoginDesktopRedirectURIEnv, larkDesktopTestRedirectURI)
}

// startLarkDesktop 调用 desktop-start，要求跳转到飞书授权页，返回授权地址的查询参数。
func startLarkDesktop(t *testing.T, h *Handler, nonce string) url.Values {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, LarkDesktopStartPath+"?nonce="+url.QueryEscape(nonce), nil)
	resp := testutil.Call(t, h.LarkDesktopStart, req).Want(http.StatusFound)

	location, err := url.Parse(resp.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse Location %q: %v", resp.Header().Get("Location"), err)
	}
	if got := location.Scheme + "://" + location.Host + location.Path; got != larkAuthorizeURL {
		t.Fatalf("redirected to %q, want the Feishu authorize page %q", got, larkAuthorizeURL)
	}

	return location.Query()
}

// callLarkDesktopCallback 用给定参数调用 desktop-callback 并检查状态码。
func callLarkDesktopCallback(t *testing.T, h *Handler, query url.Values, want int) *testutil.Response {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, LarkDesktopCallbackPath+"?"+query.Encode(), nil)

	return testutil.Call(t, h.LarkDesktopCallback, req).Want(want)
}

// assertLarkDesktopPage 检查页面是不缓存的 HTML，并且包含 want 中的每段文案。
func assertLarkDesktopPage(t *testing.T, resp *testutil.Response, want ...string) {
	t.Helper()

	if got := resp.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", got)
	}
	if got := resp.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := resp.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}

	body := resp.Text()
	for _, text := range want {
		if !strings.Contains(body, text) {
			t.Fatalf("page does not contain %q:\n%s", text, body)
		}
	}
}

func TestLarkDesktopStartRejectsInvalidNonce(t *testing.T) {
	setLarkDesktopEnv(t, "")
	h := newLarkDesktopTestHandler(Config{})

	tests := []struct {
		name  string
		nonce string
	}{
		{name: "missing", nonce: ""},
		{name: "too short", nonce: strings.Repeat("a", larkDesktopNonceMinLen-1)},
		{name: "too long", nonce: strings.Repeat("a", larkDesktopNonceMaxLen+1)},
		{name: "dot", nonce: strings.Repeat("a", larkDesktopNonceMinLen) + "."},
		{name: "percent", nonce: strings.Repeat("a", larkDesktopNonceMinLen) + "%"},
		{name: "markup", nonce: strings.Repeat("a", larkDesktopNonceMinLen) + "<b>"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, LarkDesktopStartPath+"?nonce="+url.QueryEscape(tt.nonce), nil)
			resp := testutil.Call(t, h.LarkDesktopStart, req).Want(http.StatusBadRequest)

			assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
		})
	}

	if got := h.larkDesktopStates.pending(); got != 0 {
		t.Fatalf("pending states = %d, want none for rejected nonces", got)
	}
}

func TestLarkDesktopStartNotConfigured(t *testing.T) {
	notAdvertising := func() string { return "" }
	tests := []struct {
		name        string
		secret      string
		redirectURI string
		lanHostname func() string
	}{
		{name: "feishu login not configured", secret: "", redirectURI: larkDesktopTestRedirectURI},
		{name: "lan discovery off", secret: larkTestAppSecret},
		{name: "lan discovery not advertising yet", secret: larkTestAppSecret, lanHostname: notAdvertising},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(larkLoginAppIDEnv, larkTestAppID)
			t.Setenv(larkLoginAppSecretEnv, tt.secret)
			t.Setenv(larkLoginDesktopRedirectURIEnv, tt.redirectURI)
			h := newLarkDesktopTestHandler(Config{LANHostname: tt.lanHostname, LANPort: 13840})

			req := httptest.NewRequest(http.MethodGet, LarkDesktopStartPath+"?nonce="+larkDesktopTestNonce, nil)
			resp := testutil.Call(t, h.LarkDesktopStart, req).Want(http.StatusForbidden)

			assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageNotConfigured)
		})
	}
}

func TestLarkDesktopStartRedirectsToFeishu(t *testing.T) {
	tests := []struct {
		name            string
		envRedirectURI  string
		lanHostname     string
		nonce           string
		wantRedirectURI string
	}{
		{
			name:            "configured callback address",
			envRedirectURI:  larkDesktopTestRedirectURI,
			nonce:           larkDesktopTestNonce,
			wantRedirectURI: larkDesktopTestRedirectURI,
		},
		{
			name:            "configured address wins over the advertised host",
			envRedirectURI:  larkDesktopTestRedirectURI,
			lanHostname:     "marvis.local",
			nonce:           larkDesktopTestNonce,
			wantRedirectURI: larkDesktopTestRedirectURI,
		},
		{
			name:            "derived from the advertised host and listen port",
			lanHostname:     "marvis-2.local",
			nonce:           larkDesktopTestNonce,
			wantRedirectURI: "http://marvis-2.local:13840/auth/lark/desktop-callback",
		},
		{
			name:            "shortest nonce",
			envRedirectURI:  larkDesktopTestRedirectURI,
			nonce:           strings.Repeat("Z", larkDesktopNonceMinLen),
			wantRedirectURI: larkDesktopTestRedirectURI,
		},
		{
			name:            "longest nonce",
			envRedirectURI:  larkDesktopTestRedirectURI,
			nonce:           strings.Repeat("9", larkDesktopNonceMaxLen),
			wantRedirectURI: larkDesktopTestRedirectURI,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setLarkLoginEnv(t, "")
			t.Setenv(larkLoginDesktopRedirectURIEnv, tt.envRedirectURI)
			h := newLarkDesktopTestHandler(Config{LANHostname: func() string { return tt.lanHostname }, LANPort: 13840})

			query := startLarkDesktop(t, h, tt.nonce)

			if got := query.Get("client_id"); got != larkTestAppID {
				t.Fatalf("client_id = %q, want %q", got, larkTestAppID)
			}
			if got := query.Get("redirect_uri"); got != tt.wantRedirectURI {
				t.Fatalf("redirect_uri = %q, want %q", got, tt.wantRedirectURI)
			}
			if got := query.Get("scope"); got != larkLoginScope {
				t.Fatalf("scope = %q, want %q", got, larkLoginScope)
			}

			state := query.Get("state")
			if state == "" || strings.Contains(state, tt.nonce) {
				t.Fatalf("state = %q, want a fresh value unrelated to the nonce", state)
			}

			pending, ok := h.larkDesktopStates.consume(state)
			if !ok || pending.nonce != tt.nonce || pending.redirectURI != tt.wantRedirectURI {
				t.Fatalf("stored state = %+v ok=%v, want nonce and redirect_uri recorded", pending, ok)
			}
		})
	}
}

func TestLarkDesktopStartIssuesDistinctStates(t *testing.T) {
	setLarkDesktopEnv(t, "")
	h := newLarkDesktopTestHandler(Config{})

	first := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
	second := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")

	if first == second {
		t.Fatalf("two starts produced the same state %q", first)
	}
}

func TestLarkDesktopCallbackSuccess(t *testing.T) {
	setLarkDesktopEnv(t, larkTestTenantKey)
	email := "lark-desktop-success@example.com"
	userID := dbfx.User(t, "lark-desktop-success", email)
	h, stub := newLarkStubHandler(t, Config{AllowSignup: false}, larkOAuthSuccessResponses(
		larkUserInfoBody(" LARK-DESKTOP-SUCCESS@EXAMPLE.COM ", "", larkTestTenantKey),
	))
	h.Queries = testHandler.Queries

	state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
	resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {state}}, http.StatusOK)

	assertLarkDesktopPage(t, resp, larkDesktopOpenButton)
	if csp := resp.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'sha256-") {
		t.Fatalf("Content-Security-Policy = %q, want the inline script pinned by hash", csp)
	}
	for _, cookie := range resp.Result().Cookies() {
		if cookie.Name == auth.AuthCookieName {
			t.Fatal("desktop login must not leave an auth cookie in the browser")
		}
	}

	match := larkDesktopHrefPattern.FindStringSubmatch(resp.Text())
	if match == nil {
		t.Fatalf("success page has no link:\n%s", resp.Text())
	}
	deepLink, err := url.Parse(html.UnescapeString(match[1]))
	if err != nil {
		t.Fatalf("parse deep link %q: %v", match[1], err)
	}
	if deepLink.Scheme != "marvis" || deepLink.Host != "auth" || deepLink.Path != "/callback" {
		t.Fatalf("deep link = %q, want marvis://auth/callback", deepLink)
	}
	if got := deepLink.Query().Get("nonce"); got != larkDesktopTestNonce {
		t.Fatalf("deep link nonce = %q, want %q", got, larkDesktopTestNonce)
	}

	token := deepLink.Query().Get("token")
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) { return auth.JWTSecret(), nil }); err != nil {
		t.Fatalf("deep link token is not a valid login token: %v", err)
	}
	if claims["sub"] != userID {
		t.Fatalf("token subject = %v, want %s", claims["sub"], userID)
	}

	tokenReq := stub.requests[larkPathOAuthToken]
	if tokenReq.body["code"] != larkDesktopTestCode || tokenReq.body["redirect_uri"] != larkDesktopTestRedirectURI {
		t.Fatalf("token exchange body = %v, want the code and the redirect_uri sent to the authorize page", tokenReq.body)
	}

	// 同一个 state 只能用一次。
	reused := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {state}}, http.StatusBadRequest)
	assertLarkDesktopPage(t, reused, larkDesktopTitleFailed, larkDesktopMessageExpired)
}

func TestLarkDesktopCallbackStateRules(t *testing.T) {
	setLarkDesktopEnv(t, "")

	t.Run("unknown state", func(t *testing.T) {
		h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

		resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {"forged"}}, http.StatusBadRequest)

		assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
	})

	t.Run("missing state", func(t *testing.T) {
		h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

		resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}}, http.StatusBadRequest)

		assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
	})

	t.Run("expired state", func(t *testing.T) {
		h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})
		now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
		h.larkDesktopStates.now = func() time.Time { return now }

		state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
		now = now.Add(larkDesktopStateTTL + time.Second)
		resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {state}}, http.StatusBadRequest)

		assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
	})

	t.Run("state used by a cancelled attempt", func(t *testing.T) {
		h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

		state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
		callLarkDesktopCallback(t, h, url.Values{"error": {larkOAuthErrorAccessDenied}, "state": {state}}, http.StatusOK)
		resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {state}}, http.StatusBadRequest)

		assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
	})

	t.Run("missing code", func(t *testing.T) {
		h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

		state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
		resp := callLarkDesktopCallback(t, h, url.Values{"state": {state}}, http.StatusBadRequest)

		assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageExpired)
	})
}

func TestLarkDesktopCallbackCancelled(t *testing.T) {
	setLarkDesktopEnv(t, "")
	h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

	state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
	resp := callLarkDesktopCallback(t, h, url.Values{"error": {larkOAuthErrorAccessDenied}, "state": {state}}, http.StatusOK)

	assertLarkDesktopPage(t, resp, larkDesktopTitleCancelled)
	if strings.Contains(resp.Text(), larkDesktopTitleFailed) {
		t.Fatalf("cancel page reads as a failure:\n%s", resp.Text())
	}
}

func TestLarkDesktopCallbackFailures(t *testing.T) {
	tests := []struct {
		name        string
		tenantKeys  string
		responses   map[string]larkStubResponse
		queries     *db.Queries
		query       func(state string) url.Values
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "feishu reports an error other than cancel",
			responses:   map[string]larkStubResponse{},
			query:       func(state string) url.Values { return url.Values{"error": {"server_error"}, "state": {state}} },
			wantStatus:  http.StatusBadRequest,
			wantMessage: larkDesktopMessageFailed,
		},
		{
			name: "authorization code rejected",
			responses: map[string]larkStubResponse{
				larkPathOAuthToken: {status: http.StatusBadRequest, body: `{"code":20003,"error":"invalid_grant"}`},
			},
			wantStatus:  http.StatusBadRequest,
			wantMessage: larkDesktopMessageExpired,
		},
		{
			name: "feishu unavailable",
			responses: map[string]larkStubResponse{
				larkPathOAuthToken: {status: http.StatusInternalServerError, body: `{"code":99991400,"msg":"internal error"}`},
			},
			wantStatus:  http.StatusBadGateway,
			wantMessage: larkDesktopMessageFailed,
		},
		{
			name:        "tenant not allowed",
			tenantKeys:  larkTestTenantKey,
			responses:   larkOAuthSuccessResponses(larkUserInfoBody("user@example.com", "", "tenant-other")),
			wantStatus:  http.StatusForbidden,
			wantMessage: larkDesktopMessageTenantNotAllowed,
		},
		{
			name:        "no email",
			responses:   larkOAuthSuccessResponses(larkUserInfoBody(" ", "", larkTestTenantKey)),
			wantStatus:  http.StatusBadRequest,
			wantMessage: larkDesktopMessageNoEmail,
		},
		{
			name:        "signup prohibited",
			responses:   larkOAuthSuccessResponses(larkUserInfoBody("new-desktop@example.com", "", larkTestTenantKey)),
			queries:     db.New(&mockDB{getUserErr: pgx.ErrNoRows}),
			wantStatus:  http.StatusForbidden,
			wantMessage: larkDesktopMessageSignupProhibited,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setLarkDesktopEnv(t, tt.tenantKeys)
			h, _ := newLarkStubHandler(t, Config{AllowSignup: false}, tt.responses)
			if tt.queries != nil {
				h.Queries = tt.queries
			}

			state := startLarkDesktop(t, h, larkDesktopTestNonce).Get("state")
			query := url.Values{"code": {larkDesktopTestCode}, "state": {state}}
			if tt.query != nil {
				query = tt.query(state)
			}
			resp := callLarkDesktopCallback(t, h, query, tt.wantStatus)

			assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, tt.wantMessage)
			if strings.Contains(resp.Text(), "marvis://") {
				t.Fatalf("failure page links back to the desktop app:\n%s", resp.Text())
			}
		})
	}
}

func TestLarkDesktopCallbackNotConfigured(t *testing.T) {
	t.Setenv(larkLoginAppIDEnv, larkTestAppID)
	t.Setenv(larkLoginAppSecretEnv, "")
	h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

	resp := callLarkDesktopCallback(t, h, url.Values{"code": {larkDesktopTestCode}, "state": {"any"}}, http.StatusForbidden)

	assertLarkDesktopPage(t, resp, larkDesktopTitleFailed, larkDesktopMessageNotConfigured)
}

func TestLarkDesktopPageEscapesText(t *testing.T) {
	rec := httptest.NewRecorder()

	writeLarkDesktopPage(rec, http.StatusBadRequest, larkDesktopPage{Title: "<b>标题</b>", Message: `<script>alert("x")</script>`})

	body := rec.Body.String()
	if strings.Contains(body, "<b>标题</b>") || strings.Contains(body, `<script>alert`) {
		t.Fatalf("page text was not escaped:\n%s", body)
	}
	if !strings.Contains(body, "&lt;b&gt;标题&lt;/b&gt;") {
		t.Fatalf("escaped title missing:\n%s", body)
	}
}

func TestLarkDesktopStateStoreCapsPendingStates(t *testing.T) {
	store := &larkDesktopStateStore{}

	states := make([]string, 0, larkDesktopMaxPendingStates+1)
	for i := 0; i <= larkDesktopMaxPendingStates; i++ {
		state, err := store.put(larkDesktopTestNonce+strconv.Itoa(i), larkDesktopTestRedirectURI)
		if err != nil {
			t.Fatalf("put #%d: %v", i, err)
		}
		states = append(states, state)
	}

	if got := store.pending(); got != larkDesktopMaxPendingStates {
		t.Fatalf("pending states = %d, want the cap %d", got, larkDesktopMaxPendingStates)
	}
	if _, ok := store.consume(states[0]); ok {
		t.Fatal("the oldest state survived after the cap was reached")
	}
	if got, ok := store.consume(states[len(states)-1]); !ok || got.nonce != larkDesktopTestNonce+strconv.Itoa(larkDesktopMaxPendingStates) {
		t.Fatalf("newest state = %+v ok=%v, want it kept", got, ok)
	}
}

func TestLarkDesktopStateStoreDropsExpiredStates(t *testing.T) {
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	store := &larkDesktopStateStore{now: func() time.Time { return now }}

	if _, err := store.put(larkDesktopTestNonce, larkDesktopTestRedirectURI); err != nil {
		t.Fatalf("put: %v", err)
	}
	now = now.Add(larkDesktopStateTTL + time.Second)
	fresh, err := store.put(larkDesktopTestNonce, larkDesktopTestRedirectURI)
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	if got := store.pending(); got != 1 {
		t.Fatalf("pending states = %d, want the expired one cleaned up", got)
	}
	if _, ok := store.consume(fresh); !ok {
		t.Fatal("fresh state was dropped")
	}
	if _, ok := store.consume(fresh); ok {
		t.Fatal("state was accepted twice")
	}
}
