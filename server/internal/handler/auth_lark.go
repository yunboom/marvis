package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/logger"
)

// 飞书登录相关环境变量。
const (
	larkLoginAppIDEnv      = "MARVIS_LARK_LOGIN_APP_ID"
	larkLoginAppSecretEnv  = "MARVIS_LARK_LOGIN_APP_SECRET"
	larkLoginTenantKeysEnv = "MARVIS_LARK_LOGIN_TENANT_KEYS"
)

// 飞书登录的授权码来源：网页 OAuth 授权，或飞书客户端内 tt.requestAccess 免登。
const (
	larkLoginSourceOAuth  = "oauth"
	larkLoginSourceClient = "client"
)

// 飞书登录专属错误码；账号禁用、注册限制等与 Google 登录共用 googleLoginCode*。
const (
	larkLoginCodeNotConfigured    = "lark_login_not_configured"
	larkLoginCodeAccountNoEmail   = "lark_account_no_email"
	larkLoginCodeTenantNotAllowed = "lark_tenant_not_allowed"
)

// 飞书开放平台接口。
const (
	defaultLarkLoginAPIBaseURL     = "https://open.feishu.cn"
	larkPathOAuthToken             = "/open-apis/authen/v2/oauth/token"
	larkPathAppAccessToken         = "/open-apis/auth/v3/app_access_token/internal"
	larkPathOIDCAccessToken        = "/open-apis/authen/v1/oidc/access_token"
	larkPathUserInfo               = "/open-apis/authen/v1/user_info"
	larkGrantTypeAuthorizationCode = "authorization_code"
	larkResponseBodyLimit          = 1 << 20
)

// larkInvalidAuthCodeErrorCodes 是飞书返回的「授权码无效 / 已过期 / 已使用」错误码。
var larkInvalidAuthCodeErrorCodes = map[int]struct{}{
	20003: {},
	20004: {},
	20065: {},
}

// errLarkInvalidAuthCode 表示授权码被飞书拒绝，客户端需要重新发起授权。
var errLarkInvalidAuthCode = errors.New("lark authorization code is invalid")

// LarkLoginRequest 是 POST /auth/lark 的请求体。
type LarkLoginRequest struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
	// Source 取值 oauth（默认）或 client。
	Source string `json:"source"`
}

// larkAPIStatus 是飞书接口响应里的公共错误字段。
type larkAPIStatus struct {
	Code             int    `json:"code"`
	Msg              string `json:"msg"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type larkOAuthTokenResponse struct {
	larkAPIStatus
	AccessToken string `json:"access_token"`
}

type larkAppAccessTokenResponse struct {
	larkAPIStatus
	AppAccessToken string `json:"app_access_token"`
}

type larkOIDCAccessTokenResponse struct {
	larkAPIStatus
	Data *struct {
		AccessToken string `json:"access_token"`
	} `json:"data"`
}

type larkUserInfo struct {
	Name            string `json:"name"`
	AvatarURL       string `json:"avatar_url"`
	OpenID          string `json:"open_id"`
	UnionID         string `json:"union_id"`
	Email           string `json:"email"`
	EnterpriseEmail string `json:"enterprise_email"`
	TenantKey       string `json:"tenant_key"`
}

type larkUserInfoResponse struct {
	larkAPIStatus
	Data *larkUserInfo `json:"data"`
}

func (h *Handler) larkHTTPClient() *http.Client {
	if h.larkLoginHTTPClient != nil {
		return h.larkLoginHTTPClient
	}

	return http.DefaultClient
}

func (h *Handler) larkAPIBaseURL() string {
	if h.larkLoginAPIBaseURL != "" {
		return h.larkLoginAPIBaseURL
	}

	return defaultLarkLoginAPIBaseURL
}

// larkAllowedTenantKeys 解析租户白名单；返回空集合表示不限制租户。
func larkAllowedTenantKeys() map[string]struct{} {
	allowed := make(map[string]struct{})
	for _, key := range strings.Split(os.Getenv(larkLoginTenantKeysEnv), ",") {
		key = strings.TrimSpace(key)
		if key != "" {
			allowed[key] = struct{}{}
		}
	}

	return allowed
}

// larkTenantAllowed 判断租户能否登录；未配置白名单时不限制。
func larkTenantAllowed(tenantKey string) bool {
	allowed := larkAllowedTenantKeys()
	if len(allowed) == 0 {
		return true
	}

	_, ok := allowed[tenantKey]

	return ok
}

// larkLoginCredentials 读取飞书登录应用的 App ID 与 App Secret，任一为空时 ok 为 false。
func larkLoginCredentials() (appID, appSecret string, ok bool) {
	appID = os.Getenv(larkLoginAppIDEnv)
	appSecret = os.Getenv(larkLoginAppSecretEnv)

	return appID, appSecret, appID != "" && appSecret != ""
}

// LarkLoginCredentials 返回飞书登录应用的 App ID 与 App Secret，任一为空时 ok 为 false。
// 供 cmd/server 在启用飞书邀请时复用同一个应用，不另开一套配置。
func LarkLoginCredentials() (appID, appSecret string, ok bool) {
	return larkLoginCredentials()
}

// larkUserEmail 返回飞书用户的登录邮箱：优先 email，没有时取 enterprise_email，去掉空白并转小写；都没有时返回空串。
func larkUserEmail(user *larkUserInfo) string {
	email := strings.ToLower(strings.TrimSpace(user.Email))
	if email == "" {
		email = strings.ToLower(strings.TrimSpace(user.EnterpriseEmail))
	}

	return email
}

// LarkLogin 用飞书授权码登录：换取 user_access_token、读取用户信息，按邮箱匹配或创建账号。
func (h *Handler) LarkLogin(w http.ResponseWriter, r *http.Request) {
	var req LarkLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	source := req.Source
	if source == "" {
		source = larkLoginSourceOAuth
	}
	if source != larkLoginSourceOAuth && source != larkLoginSourceClient {
		writeError(w, http.StatusBadRequest, "source must be oauth or client")
		return
	}

	appID, appSecret, configured := larkLoginCredentials()
	if !configured {
		writeFeatureDisabled(w, larkLoginCodeNotConfigured, "Lark login is not configured")
		return
	}

	var accessToken string
	var err error
	if source == larkLoginSourceClient {
		accessToken, err = h.exchangeLarkClientCode(r.Context(), appID, appSecret, req.Code)
	} else {
		accessToken, err = h.exchangeLarkOAuthCode(r.Context(), appID, appSecret, req.Code, req.RedirectURI)
	}
	if err != nil {
		if errors.Is(err, errLarkInvalidAuthCode) {
			slog.Warn("lark login code rejected", append(logger.RequestAttrs(r), "error", err, "source", source)...)
			writeErrorCode(w, http.StatusBadRequest, googleLoginCodeInvalidOAuthCode, "failed to exchange code with Lark")
			return
		}
		slog.Error("lark token exchange failed", append(logger.RequestAttrs(r), "error", err, "source", source)...)
		writeError(w, http.StatusBadGateway, "failed to exchange code with Lark")
		return
	}

	larkUser, err := h.fetchLarkUserInfo(r.Context(), accessToken)
	if err != nil {
		slog.Error("lark user info fetch failed", append(logger.RequestAttrs(r), "error", err, "source", source)...)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Lark")
		return
	}

	// 租户白名单先于邮箱检查，避免向白名单外的租户暴露账号细节。
	if !larkTenantAllowed(larkUser.TenantKey) {
		slog.Warn("lark login tenant not allowed", append(logger.RequestAttrs(r), "tenant_key", larkUser.TenantKey, "open_id", larkUser.OpenID)...)
		writeErrorCode(w, http.StatusForbidden, larkLoginCodeTenantNotAllowed, "this Lark tenant is not allowed to sign in")
		return
	}

	email := larkUserEmail(larkUser)
	if email == "" {
		writeErrorCode(w, http.StatusBadRequest, larkLoginCodeAccountNoEmail, "Lark did not provide an email address for this sign-in")
		return
	}

	h.completeOAuthLogin(w, r, oauthLoginProfile{
		Email:     email,
		Name:      larkUser.Name,
		AvatarURL: larkUser.AvatarURL,
	}, authMethodLark)
}

// exchangeLarkOAuthCode 用网页 OAuth 授权码换取 user_access_token。
func (h *Handler) exchangeLarkOAuthCode(ctx context.Context, appID, appSecret, code, redirectURI string) (string, error) {
	payload := map[string]string{
		"grant_type":    larkGrantTypeAuthorizationCode,
		"client_id":     appID,
		"client_secret": appSecret,
		"code":          code,
	}
	if redirectURI != "" {
		payload["redirect_uri"] = redirectURI
	}

	var resp larkOAuthTokenResponse
	status, err := h.callLarkAPI(ctx, http.MethodPost, larkPathOAuthToken, "", payload, &resp)
	if err != nil {
		return "", err
	}
	if err := larkAuthCodeError(larkPathOAuthToken, status, resp.larkAPIStatus); err != nil {
		return "", err
	}

	if strings.TrimSpace(resp.AccessToken) == "" {
		return "", errors.Errorf("lark oauth token response has no access token: path=%s", larkPathOAuthToken)
	}

	return resp.AccessToken, nil
}

// exchangeLarkClientCode 用飞书客户端免登拿到的授权码换取 user_access_token：
// 先取 app_access_token，再调 OIDC 接口。
func (h *Handler) exchangeLarkClientCode(ctx context.Context, appID, appSecret, code string) (string, error) {
	var appResp larkAppAccessTokenResponse
	status, err := h.callLarkAPI(ctx, http.MethodPost, larkPathAppAccessToken, "", map[string]string{
		"app_id":     appID,
		"app_secret": appSecret,
	}, &appResp)
	if err != nil {
		return "", err
	}
	if err := larkStatusError(larkPathAppAccessToken, status, appResp.larkAPIStatus); err != nil {
		return "", err
	}
	if strings.TrimSpace(appResp.AppAccessToken) == "" {
		return "", errors.Errorf("lark app access token response has no token: path=%s", larkPathAppAccessToken)
	}

	var oidcResp larkOIDCAccessTokenResponse
	status, err = h.callLarkAPI(ctx, http.MethodPost, larkPathOIDCAccessToken, appResp.AppAccessToken, map[string]string{
		"grant_type": larkGrantTypeAuthorizationCode,
		"code":       code,
	}, &oidcResp)
	if err != nil {
		return "", err
	}
	if err := larkAuthCodeError(larkPathOIDCAccessToken, status, oidcResp.larkAPIStatus); err != nil {
		return "", err
	}

	if oidcResp.Data == nil || strings.TrimSpace(oidcResp.Data.AccessToken) == "" {
		return "", errors.Errorf("lark oidc token response has no access token: path=%s", larkPathOIDCAccessToken)
	}

	return oidcResp.Data.AccessToken, nil
}

// fetchLarkUserInfo 用 user_access_token 读取当前登录用户信息。
func (h *Handler) fetchLarkUserInfo(ctx context.Context, accessToken string) (*larkUserInfo, error) {
	var resp larkUserInfoResponse
	status, err := h.callLarkAPI(ctx, http.MethodGet, larkPathUserInfo, accessToken, nil, &resp)
	if err != nil {
		return nil, err
	}
	if err := larkStatusError(larkPathUserInfo, status, resp.larkAPIStatus); err != nil {
		return nil, err
	}

	if resp.Data == nil {
		return nil, errors.Errorf("lark user info response has no data: path=%s", larkPathUserInfo)
	}

	return resp.Data, nil
}

// callLarkAPI 发起一次飞书接口调用并把 JSON 响应解码到 out，返回 HTTP 状态码。
// payload 为 nil 时不带请求体；bearer 为空时不带 Authorization。
func (h *Handler) callLarkAPI(ctx context.Context, method, path, bearer string, payload, out any) (int, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, errors.Wrapf(err, "encode lark request: path=%s", path)
		}
		body = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, h.larkAPIBaseURL()+path, body)
	if err != nil {
		return 0, errors.Wrapf(err, "build lark request: path=%s", path)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := h.larkHTTPClient().Do(req)
	if err != nil {
		return 0, errors.Wrapf(err, "call lark api: path=%s", path)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, larkResponseBodyLimit))
	if err != nil {
		return resp.StatusCode, errors.Wrapf(err, "read lark response: path=%s status=%d", path, resp.StatusCode)
	}

	if err := json.Unmarshal(raw, out); err != nil {
		return resp.StatusCode, errors.Wrapf(err, "decode lark response: path=%s status=%d body=%q", path, resp.StatusCode, truncateLarkBody(raw))
	}

	return resp.StatusCode, nil
}

// larkStatusError 把非 200 或 code 非 0 的飞书响应转成错误。
func larkStatusError(path string, status int, apiStatus larkAPIStatus) error {
	if status == http.StatusOK && apiStatus.Code == 0 {
		return nil
	}

	return errors.Errorf("lark api returned error: path=%s status=%d code=%d msg=%q error=%q error_description=%q",
		path, status, apiStatus.Code, apiStatus.Msg, apiStatus.Error, apiStatus.ErrorDescription)
}

// larkAuthCodeError 在 larkStatusError 基础上识别授权码无效的错误码；服务端 5xx 一律视为上游故障。
func larkAuthCodeError(path string, status int, apiStatus larkAPIStatus) error {
	err := larkStatusError(path, status, apiStatus)
	if err == nil {
		return nil
	}

	if _, ok := larkInvalidAuthCodeErrorCodes[apiStatus.Code]; ok && status < http.StatusInternalServerError {
		return errors.Wrapf(errLarkInvalidAuthCode, "path=%s status=%d code=%d", path, status, apiStatus.Code)
	}

	return err
}

func truncateLarkBody(raw []byte) string {
	const limit = 512
	if len(raw) > limit {
		return string(raw[:limit])
	}

	return string(raw)
}
