package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/yunboom/marvis/server/internal/auth"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// larkStub 是飞书开放接口的本地桩，按路径返回预设响应并记录收到的请求。
type larkStub struct {
	t         *testing.T
	responses map[string]larkStubResponse
	requests  map[string]larkStubRequest
}

type larkStubResponse struct {
	status int
	body   string
}

type larkStubRequest struct {
	authorization string
	body          map[string]string
}

const (
	larkTestAppID     = "cli_test_app"
	larkTestAppSecret = "test-secret"
	larkTestUserToken = "u-test-token"
	larkTestAppToken  = "a-test-token"
	larkTestTenantKey = "tenant-allowed"
)

func newLarkStubHandler(t *testing.T, cfg Config, responses map[string]larkStubResponse) (*Handler, *larkStub) {
	t.Helper()

	stub := &larkStub{t: t, responses: responses, requests: make(map[string]larkStubRequest)}
	srv := httptest.NewServer(http.HandlerFunc(stub.serve))
	t.Cleanup(srv.Close)

	h := newLarkDesktopTestHandler(cfg)
	h.larkLoginHTTPClient = srv.Client()
	h.larkLoginAPIBaseURL = srv.URL

	return h, stub
}

func (s *larkStub) serve(w http.ResponseWriter, r *http.Request) {
	resp, ok := s.responses[r.URL.Path]
	if !ok {
		s.t.Errorf("unexpected Lark request: %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
		return
	}

	recorded := larkStubRequest{authorization: r.Header.Get("Authorization")}
	if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
		if err := json.Unmarshal(raw, &recorded.body); err != nil {
			s.t.Errorf("Lark request body is not JSON: %s", raw)
		}
	}
	s.requests[r.URL.Path] = recorded

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.status)
	_, _ = io.WriteString(w, resp.body)
}

func setLarkLoginEnv(t *testing.T, tenantKeys string) {
	t.Helper()

	t.Setenv(larkLoginAppIDEnv, larkTestAppID)
	t.Setenv(larkLoginAppSecretEnv, larkTestAppSecret)
	t.Setenv(larkLoginTenantKeysEnv, tenantKeys)
}

func larkUserInfoBody(email, enterpriseEmail, tenantKey string) string {
	body, _ := json.Marshal(map[string]any{
		"code": 0,
		"msg":  "success",
		"data": map[string]string{
			"name":             "飞书用户",
			"avatar_url":       "https://example.com/lark-avatar.png",
			"open_id":          "ou_test",
			"union_id":         "on_test",
			"email":            email,
			"enterprise_email": enterpriseEmail,
			"tenant_key":       tenantKey,
		},
	})

	return string(body)
}

func larkOAuthSuccessResponses(userInfo string) map[string]larkStubResponse {
	return map[string]larkStubResponse{
		larkPathOAuthToken: {status: http.StatusOK, body: `{"code":0,"access_token":"` + larkTestUserToken + `","token_type":"Bearer"}`},
		larkPathUserInfo:   {status: http.StatusOK, body: userInfo},
	}
}

type larkErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func callLarkLogin(t *testing.T, h *Handler, body string, wantStatus int) larkErrorBody {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, "/auth/lark", strings.NewReader(body))
	var got larkErrorBody
	testutil.Call(t, h.LarkLogin, req).Want(wantStatus).JSON(&got)

	return got
}

func TestLarkLoginNotConfigured(t *testing.T) {
	t.Setenv(larkLoginAppIDEnv, larkTestAppID)
	t.Setenv(larkLoginAppSecretEnv, "")
	h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

	got := callLarkLogin(t, h, `{"code":"test-code"}`, http.StatusForbidden)

	if got.Code != larkLoginCodeNotConfigured {
		t.Fatalf("got code=%q, want %q", got.Code, larkLoginCodeNotConfigured)
	}
}

func TestLarkLoginRejectsInvalidRequest(t *testing.T) {
	setLarkLoginEnv(t, "")
	h, _ := newLarkStubHandler(t, Config{}, map[string]larkStubResponse{})

	callLarkLogin(t, h, `{"code":""}`, http.StatusBadRequest)
	callLarkLogin(t, h, `{"code":"test-code","source":"desktop"}`, http.StatusBadRequest)
}

func TestLarkLoginInvalidAuthCode(t *testing.T) {
	setLarkLoginEnv(t, "")
	appTokenOK := larkStubResponse{status: http.StatusOK, body: `{"code":0,"msg":"ok","app_access_token":"` + larkTestAppToken + `"}`}
	tests := []struct {
		name       string
		body       string
		responses  map[string]larkStubResponse
		wantStatus int
		wantCode   string
	}{
		{
			name: "oauth code invalid",
			body: `{"code":"bad-code","redirect_uri":"http://localhost/auth/callback"}`,
			responses: map[string]larkStubResponse{
				larkPathOAuthToken: {status: http.StatusBadRequest, body: `{"code":20003,"error":"invalid_grant","error_description":"code not found"}`},
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   googleLoginCodeInvalidOAuthCode,
		},
		{
			name: "oauth code already used",
			body: `{"code":"used-code","source":"oauth"}`,
			responses: map[string]larkStubResponse{
				larkPathOAuthToken: {status: http.StatusBadRequest, body: `{"code":20065,"error":"invalid_grant"}`},
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   googleLoginCodeInvalidOAuthCode,
		},
		{
			name: "client code expired",
			body: `{"code":"expired-code","source":"client"}`,
			responses: map[string]larkStubResponse{
				larkPathAppAccessToken:  appTokenOK,
				larkPathOIDCAccessToken: {status: http.StatusOK, body: `{"code":20004,"msg":"code expired"}`},
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   googleLoginCodeInvalidOAuthCode,
		},
		{
			name: "server error is not an invalid code",
			body: `{"code":"test-code"}`,
			responses: map[string]larkStubResponse{
				larkPathOAuthToken: {status: http.StatusInternalServerError, body: `{"code":20003}`},
			},
			wantStatus: http.StatusBadGateway,
		},
		{
			name: "app secret rejected",
			body: `{"code":"test-code","source":"client"}`,
			responses: map[string]larkStubResponse{
				larkPathAppAccessToken: {status: http.StatusOK, body: `{"code":10014,"msg":"app secret invalid"}`},
			},
			wantStatus: http.StatusBadGateway,
		},
		{
			name: "user info failure",
			body: `{"code":"test-code"}`,
			responses: larkOAuthSuccessResponses(
				`{"code":99991663,"msg":"invalid access token"}`,
			),
			wantStatus: http.StatusBadGateway,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, _ := newLarkStubHandler(t, Config{}, tt.responses)

			got := callLarkLogin(t, h, tt.body, tt.wantStatus)

			if got.Code != tt.wantCode || got.Error == "" {
				t.Fatalf("got code=%q error=%q, want code=%q and a message", got.Code, got.Error, tt.wantCode)
			}
		})
	}
}

func TestLarkLoginProfileRejections(t *testing.T) {
	tests := []struct {
		name       string
		tenantKeys string
		userInfo   string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "no email",
			userInfo:   larkUserInfoBody("", " ", larkTestTenantKey),
			wantStatus: http.StatusBadRequest,
			wantCode:   larkLoginCodeAccountNoEmail,
		},
		{
			name:       "tenant not allowed",
			tenantKeys: larkTestTenantKey + ", another-tenant",
			userInfo:   larkUserInfoBody("user@example.com", "", "tenant-other"),
			wantStatus: http.StatusForbidden,
			wantCode:   larkLoginCodeTenantNotAllowed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setLarkLoginEnv(t, tt.tenantKeys)
			h, _ := newLarkStubHandler(t, Config{}, larkOAuthSuccessResponses(tt.userInfo))

			got := callLarkLogin(t, h, `{"code":"test-code"}`, tt.wantStatus)

			if got.Code != tt.wantCode {
				t.Fatalf("got code=%q error=%q, want code=%q", got.Code, got.Error, tt.wantCode)
			}
		})
	}
}

func TestLarkLoginSignupRestrictionsShareGoogleCodes(t *testing.T) {
	setLarkLoginEnv(t, "")
	h, _ := newLarkStubHandler(t, Config{AllowSignup: false}, larkOAuthSuccessResponses(larkUserInfoBody("new@example.com", "", larkTestTenantKey)))
	h.Queries = db.New(&mockDB{getUserErr: pgx.ErrNoRows})

	got := callLarkLogin(t, h, `{"code":"test-code"}`, http.StatusForbidden)

	if got.Code != googleLoginCodeSignupProhibited {
		t.Fatalf("got code=%q, want %q", got.Code, googleLoginCodeSignupProhibited)
	}
}

func TestLarkLoginOAuthSuccess(t *testing.T) {
	setLarkLoginEnv(t, larkTestTenantKey)
	email := "lark-oauth-success@example.com"
	userID := dbfx.User(t, "lark-oauth-success", email)
	h, stub := newLarkStubHandler(t, Config{AllowSignup: false}, larkOAuthSuccessResponses(
		larkUserInfoBody(" LARK-OAUTH-SUCCESS@EXAMPLE.COM ", "other@example.com", larkTestTenantKey),
	))
	h.Queries = testHandler.Queries

	req := httptest.NewRequest(http.MethodPost, "/auth/lark", strings.NewReader(`{"code":"test-code","redirect_uri":"http://localhost/auth/callback","source":"oauth"}`))
	var got LoginResponse
	resp := testutil.Call(t, h.LarkLogin, req).Want(http.StatusOK).JSON(&got)

	if got.Token == "" || got.User.ID != userID || got.User.Email != email {
		t.Fatalf("unexpected login response: token present=%t user=%+v", got.Token != "", got.User)
	}
	if got.User.Name != "飞书用户" || got.User.AvatarURL == nil || *got.User.AvatarURL != "https://example.com/lark-avatar.png" {
		t.Fatalf("profile was not synced from Lark: %+v", got.User)
	}

	tokenReq := stub.requests[larkPathOAuthToken]
	wantTokenBody := map[string]string{
		"grant_type":    larkGrantTypeAuthorizationCode,
		"client_id":     larkTestAppID,
		"client_secret": larkTestAppSecret,
		"code":          "test-code",
		"redirect_uri":  "http://localhost/auth/callback",
	}
	for key, want := range wantTokenBody {
		if tokenReq.body[key] != want {
			t.Fatalf("token request %s=%q, want %q", key, tokenReq.body[key], want)
		}
	}
	if stub.requests[larkPathUserInfo].authorization != "Bearer "+larkTestUserToken {
		t.Fatalf("user info request did not use the user access token: %q", stub.requests[larkPathUserInfo].authorization)
	}

	var hasAuthCookie bool
	for _, cookie := range resp.Result().Cookies() {
		if cookie.Name == auth.AuthCookieName && cookie.Value == got.Token {
			hasAuthCookie = true
		}
	}
	if !hasAuthCookie {
		t.Fatal("successful Lark login must set the auth cookie")
	}
}

func TestLarkLoginClientSuccess(t *testing.T) {
	setLarkLoginEnv(t, "")
	email := "lark-client-success@example.com"
	userID := dbfx.User(t, "Lark Client User", email)
	h, stub := newLarkStubHandler(t, Config{AllowSignup: false}, map[string]larkStubResponse{
		larkPathAppAccessToken:  {status: http.StatusOK, body: `{"code":0,"msg":"ok","app_access_token":"` + larkTestAppToken + `"}`},
		larkPathOIDCAccessToken: {status: http.StatusOK, body: `{"code":0,"msg":"success","data":{"access_token":"` + larkTestUserToken + `"}}`},
		larkPathUserInfo:        {status: http.StatusOK, body: larkUserInfoBody("", email, "tenant-any")},
	})
	h.Queries = testHandler.Queries

	req := httptest.NewRequest(http.MethodPost, "/auth/lark", strings.NewReader(`{"code":"client-code","source":"client"}`))
	var got LoginResponse
	testutil.Call(t, h.LarkLogin, req).Want(http.StatusOK).JSON(&got)

	if got.Token == "" || got.User.ID != userID || got.User.Email != email {
		t.Fatalf("unexpected login response: token present=%t user=%+v", got.Token != "", got.User)
	}

	appReq := stub.requests[larkPathAppAccessToken]
	if appReq.body["app_id"] != larkTestAppID || appReq.body["app_secret"] != larkTestAppSecret {
		t.Fatalf("unexpected app access token request: %v", appReq.body)
	}
	oidcReq := stub.requests[larkPathOIDCAccessToken]
	if oidcReq.authorization != "Bearer "+larkTestAppToken || oidcReq.body["code"] != "client-code" || oidcReq.body["grant_type"] != larkGrantTypeAuthorizationCode {
		t.Fatalf("unexpected oidc token request: auth=%q body=%v", oidcReq.authorization, oidcReq.body)
	}
	if stub.requests[larkPathUserInfo].authorization != "Bearer "+larkTestUserToken {
		t.Fatal("user info request did not use the user access token")
	}
}
