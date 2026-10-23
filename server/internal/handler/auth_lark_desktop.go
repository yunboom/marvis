package handler

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/auth"
	"github.com/yunboom/marvis/server/internal/logger"
)

// 桌面端飞书登录的两个浏览器地址：没有网页端时由服务端直接完成飞书授权回调。
const (
	// LarkDesktopStartPath 是桌面端在浏览器里打开的起点，校验 nonce 后跳转到飞书授权页。
	LarkDesktopStartPath = "/auth/lark/desktop-start"
	// LarkDesktopCallbackPath 是飞书授权后的回调地址，需要在飞书后台登记。
	LarkDesktopCallbackPath = "/auth/lark/desktop-callback"
)

const (
	// larkLoginDesktopRedirectURIEnv 指定桌面端飞书登录的回调地址，优先于按局域网主机名推导的地址。
	larkLoginDesktopRedirectURIEnv = "MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI"
	// larkAuthorizeURL 是飞书网页授权页，与网页端登录使用的一致。
	larkAuthorizeURL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
	// larkLoginScope 是飞书登录申请的权限，与网页端一致。
	larkLoginScope = "contact:user.email:readonly"
	// larkOAuthErrorAccessDenied 是用户在飞书授权页取消时回调带的 error。
	larkOAuthErrorAccessDenied = "access_denied"
	// larkDesktopCallbackScheme 是按局域网主机名推导回调地址时使用的协议，局域网内没有证书。
	larkDesktopCallbackScheme = "http"
	// larkDesktopDeepLinkBase 是登录成功后跳回桌面端的深链。
	larkDesktopDeepLinkBase = "marvis://auth/callback"
)

// 桌面端飞书登录用到的查询参数。
const (
	larkDesktopQueryNonce   = "nonce"
	larkDesktopQueryToken   = "token"
	larkOAuthQueryState     = "state"
	larkOAuthQueryCode      = "code"
	larkOAuthQueryError     = "error"
	larkOAuthQueryClientID  = "client_id"
	larkOAuthQueryRedirect  = "redirect_uri"
	larkOAuthQueryScopeList = "scope"
)

// 一次性 state 与桌面端 nonce 的约束。
const (
	// larkDesktopStateTTL 是 state 的有效期。
	larkDesktopStateTTL = 10 * time.Minute
	// larkDesktopMaxPendingStates 是同时保存的 state 上限，超出时淘汰最早的，限制内存占用。
	larkDesktopMaxPendingStates = 1000
	// larkDesktopStateBytes 是 state 的随机字节数。
	larkDesktopStateBytes = 32
	// larkDesktopNonceMinLen 与 larkDesktopNonceMaxLen 是 nonce 的长度范围。
	larkDesktopNonceMinLen = 32
	larkDesktopNonceMaxLen = 128
)

// 桌面端飞书登录页面的文案。
const (
	larkDesktopTitleFailed               = "飞书登录失败"
	larkDesktopTitleCancelled            = "已取消飞书登录"
	larkDesktopMessageExpired            = "登录已过期，请回到 Marvis 重新点击飞书登录"
	larkDesktopMessageTenantNotAllowed   = "这个飞书企业不允许登录"
	larkDesktopMessageNoEmail            = "飞书账号没有邮箱"
	larkDesktopMessageNotConfigured      = "服务器未配置飞书登录"
	larkDesktopMessageAccountDisabled    = "此账号已被停用"
	larkDesktopMessageSignupProhibited   = "此自托管实例已禁止用户注册"
	larkDesktopMessageEmailNotAllowed    = "此实例不允许使用该邮箱地址或域名"
	larkDesktopMessageFailed             = "无法完成登录，请回到 Marvis 重新点击飞书登录"
	larkDesktopOpenButton                = "打开 Marvis"
	larkDesktopDocumentTitleWithoutTitle = "Marvis"
)

// 桌面端飞书登录页面的响应头取值。
const (
	larkDesktopContentType    = "text/html; charset=utf-8"
	larkDesktopCacheControl   = "no-store"
	larkDesktopReferrerPolicy = "no-referrer"
	larkDesktopNoSniff        = "nosniff"
)

// larkDesktopOpenScript 在成功页加载后跳到深链；浏览器拦截自定义协议时，用户点“打开 Marvis”按钮。
const larkDesktopOpenScript = `var link=document.getElementById("open");if(link){window.location.href=link.href;}`

// larkDesktopPageHTML 是桌面端飞书登录的结果页。脚本是固定文本，CSP 按它的哈希放行。
const larkDesktopPageHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{if .Title}}{{.Title}}{{else}}` + larkDesktopDocumentTitleWithoutTitle + `{{end}}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:360px;padding:24px;text-align:center}
h1{margin:0 0 8px;font-size:18px;font-weight:600}
p{margin:0;font-size:14px;line-height:1.6;color:#52525b}
a{display:inline-block;padding:8px 16px;border-radius:8px;background:#18181b;color:#fafafa;font-size:14px;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}p{color:#a1a1aa}a{background:#fafafa;color:#09090b}}
</style>
</head>
<body>
<main>
{{- if .Title}}
<h1>{{.Title}}</h1>
{{- end}}
{{- if .Message}}
<p>{{.Message}}</p>
{{- end}}
{{- if .DeepLink}}
<a id="open" href="{{.DeepLink}}">` + larkDesktopOpenButton + `</a>
<script>` + larkDesktopOpenScript + `</script>
{{- end}}
</main>
</body>
</html>
`

var (
	// larkDesktopPageTemplate 渲染结果页，文字和链接都经 html/template 转义。
	larkDesktopPageTemplate = template.Must(template.New("lark-desktop").Parse(larkDesktopPageHTML))
	// larkDesktopPageCSP 只放行页面自带的样式和那段固定脚本，不加载任何外部资源。
	larkDesktopPageCSP = "default-src 'none'; style-src 'unsafe-inline'; script-src '" + cspScriptHash(larkDesktopOpenScript) +
		"'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

// errLarkDesktopStatesUnavailable 表示没有可用的 state 存储，只在未经 New 创建的 Handler 上出现。
var errLarkDesktopStatesUnavailable = errors.New("lark desktop login state store is not configured")

// larkDesktopPage 是结果页的内容。
type larkDesktopPage struct {
	// Title 是页面标题，为空时不显示。
	Title string
	// Message 是正文，为空时不显示。
	Message string
	// DeepLink 是跳回桌面端的深链，只在登录成功时设置。
	DeepLink template.URL
}

// larkDesktopState 是一次待完成的桌面端飞书登录。
type larkDesktopState struct {
	nonce       string
	redirectURI string
	expiresAt   time.Time
	// seq 是保存的先后顺序，达到上限时淘汰最早保存的。
	seq uint64
}

// larkDesktopStateStore 在内存里保存一次性 state（单实例部署），零值可用，并发安全。
// 方法允许 nil 接收者：nil 时不保存任何 state。
type larkDesktopStateStore struct {
	mu      sync.Mutex
	states  map[string]larkDesktopState
	nextSeq uint64
	// now 是测试注入的时钟，nil 时用 time.Now。
	now func() time.Time
}

// LarkDesktopStart 是桌面端飞书登录的起点，桌面端在浏览器里打开：
// 校验 nonce，生成一次性 state，跳转到飞书授权页。
func (h *Handler) LarkDesktopStart(w http.ResponseWriter, r *http.Request) {
	appID, _, configured := larkLoginCredentials()
	redirectURI := h.larkDesktopRedirectURI()
	if !configured || redirectURI == "" {
		writeLarkDesktopFailure(w, http.StatusForbidden, larkDesktopMessageNotConfigured)
		return
	}

	nonce := r.URL.Query().Get(larkDesktopQueryNonce)
	if !validLarkDesktopNonce(nonce) {
		writeLarkDesktopFailure(w, http.StatusBadRequest, larkDesktopMessageExpired)
		return
	}

	state, err := h.larkDesktopStates.put(nonce, redirectURI)
	if err != nil {
		slog.Error("lark desktop login state unavailable", append(logger.RequestAttrs(r), "error", err)...)
		writeLarkDesktopFailure(w, http.StatusInternalServerError, larkDesktopMessageFailed)
		return
	}

	authorize := url.Values{}
	authorize.Set(larkOAuthQueryClientID, appID)
	authorize.Set(larkOAuthQueryRedirect, redirectURI)
	authorize.Set(larkOAuthQueryScopeList, larkLoginScope)
	authorize.Set(larkOAuthQueryState, state)

	w.Header().Set("Cache-Control", larkDesktopCacheControl)
	w.Header().Set("Referrer-Policy", larkDesktopReferrerPolicy)
	http.Redirect(w, r, larkAuthorizeURL+"?"+authorize.Encode(), http.StatusFound)
}

// LarkDesktopCallback 是飞书授权后的回调：校验并作废 state，换取用户信息、找人或建号、签发登录凭证，
// 再经深链 marvis://auth/callback?token=…&nonce=… 交回桌面端。失败时显示简短的错误页。
func (h *Handler) LarkDesktopCallback(w http.ResponseWriter, r *http.Request) {
	appID, appSecret, configured := larkLoginCredentials()
	if !configured {
		writeLarkDesktopFailure(w, http.StatusForbidden, larkDesktopMessageNotConfigured)
		return
	}

	// state 不论这次结果如何都先作废，同一个 state 只能用一次。
	query := r.URL.Query()
	pending, found := h.larkDesktopStates.consume(query.Get(larkOAuthQueryState))

	if oauthErr := query.Get(larkOAuthQueryError); oauthErr != "" {
		if oauthErr == larkOAuthErrorAccessDenied {
			writeLarkDesktopPage(w, http.StatusOK, larkDesktopPage{Title: larkDesktopTitleCancelled})
			return
		}

		slog.Warn("lark desktop login authorization failed", append(logger.RequestAttrs(r), "lark_error", oauthErr)...)
		writeLarkDesktopFailure(w, http.StatusBadRequest, larkDesktopMessageFailed)
		return
	}

	code := query.Get(larkOAuthQueryCode)
	if !found || code == "" {
		writeLarkDesktopFailure(w, http.StatusBadRequest, larkDesktopMessageExpired)
		return
	}

	accessToken, err := h.exchangeLarkOAuthCode(r.Context(), appID, appSecret, code, pending.redirectURI)
	if err != nil {
		if errors.Is(err, errLarkInvalidAuthCode) {
			slog.Warn("lark desktop login code rejected", append(logger.RequestAttrs(r), "error", err)...)
			writeLarkDesktopFailure(w, http.StatusBadRequest, larkDesktopMessageExpired)
			return
		}

		slog.Error("lark desktop login token exchange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeLarkDesktopFailure(w, http.StatusBadGateway, larkDesktopMessageFailed)
		return
	}

	larkUser, err := h.fetchLarkUserInfo(r.Context(), accessToken)
	if err != nil {
		slog.Error("lark desktop login user info fetch failed", append(logger.RequestAttrs(r), "error", err)...)
		writeLarkDesktopFailure(w, http.StatusBadGateway, larkDesktopMessageFailed)
		return
	}

	// 租户白名单先于邮箱检查，与网页端飞书登录一致。
	if !larkTenantAllowed(larkUser.TenantKey) {
		slog.Warn("lark desktop login tenant not allowed", append(logger.RequestAttrs(r), "tenant_key", larkUser.TenantKey, "open_id", larkUser.OpenID)...)
		writeLarkDesktopFailure(w, http.StatusForbidden, larkDesktopMessageTenantNotAllowed)
		return
	}

	email := larkUserEmail(larkUser)
	if email == "" {
		writeLarkDesktopFailure(w, http.StatusBadRequest, larkDesktopMessageNoEmail)
		return
	}

	user, token, err := h.issueOAuthLogin(r, oauthLoginProfile{
		Email:     email,
		Name:      larkUser.Name,
		AvatarURL: larkUser.AvatarURL,
	}, authMethodLark)
	if err != nil {
		status, message, expected := larkDesktopLoginFailure(err)
		if !expected {
			slog.Warn("lark desktop login failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		}

		writeLarkDesktopFailure(w, status, message)
		return
	}

	slog.Info("user logged in via lark desktop", append(logger.RequestAttrs(r), "user_id", uuidToString(user.ID), "email", user.Email)...)

	// 深链由服务端拼出：token 是 JWT，nonce 已校验只含 [A-Za-z0-9_-]，可以放进 href。
	deepLink := template.URL(larkDesktopDeepLink(token, pending.nonce))
	writeLarkDesktopPage(w, http.StatusOK, larkDesktopPage{DeepLink: deepLink})
}

// larkDesktopLoginAvailable 判断桌面端能否不经网页端完成飞书登录：飞书登录已配置且有回调地址。
func (h *Handler) larkDesktopLoginAvailable() bool {
	_, _, configured := larkLoginCredentials()

	return configured && h.larkDesktopRedirectURI() != ""
}

// larkDesktopRedirectURI 返回桌面端飞书登录的回调地址：环境变量优先；
// 未配置时用局域网广播实际使用的主机名和服务端端口拼出；都没有时返回空串。
func (h *Handler) larkDesktopRedirectURI() string {
	if configured := strings.TrimSpace(os.Getenv(larkLoginDesktopRedirectURIEnv)); configured != "" {
		return configured
	}

	if h.cfg.LANHostname == nil || h.cfg.LANPort <= 0 {
		return ""
	}

	host := h.cfg.LANHostname()
	if host == "" {
		return ""
	}

	callback := url.URL{
		Scheme: larkDesktopCallbackScheme,
		Host:   net.JoinHostPort(host, strconv.Itoa(h.cfg.LANPort)),
		Path:   LarkDesktopCallbackPath,
	}

	return callback.String()
}

// larkDesktopLoginFailure 把签发登录凭证的错误映射为错误页的状态码与正文；
// expected 为 false 表示不是可预期的错误，调用方需要记录日志。
func larkDesktopLoginFailure(err error) (status int, message string, expected bool) {
	var signupErr SignupError

	switch {
	case errors.Is(err, auth.ErrTemporarilyDisabledUser):
		return http.StatusForbidden, larkDesktopMessageAccountDisabled, true
	case errors.Is(err, ErrSignupProhibited):
		return http.StatusForbidden, larkDesktopMessageSignupProhibited, true
	case errors.Is(err, ErrEmailNotAllowed):
		return http.StatusForbidden, larkDesktopMessageEmailNotAllowed, true
	case errors.As(err, &signupErr):
		return http.StatusForbidden, larkDesktopMessageFailed, true
	default:
		return http.StatusInternalServerError, larkDesktopMessageFailed, false
	}
}

// larkDesktopDeepLink 拼出跳回桌面端的深链。
func larkDesktopDeepLink(token, nonce string) string {
	query := url.Values{}
	query.Set(larkDesktopQueryToken, token)
	query.Set(larkDesktopQueryNonce, nonce)

	return larkDesktopDeepLinkBase + "?" + query.Encode()
}

// validLarkDesktopNonce 判断 nonce 是否只含 [A-Za-z0-9_-] 且长度在允许范围内。
func validLarkDesktopNonce(nonce string) bool {
	if len(nonce) < larkDesktopNonceMinLen || len(nonce) > larkDesktopNonceMaxLen {
		return false
	}

	for i := 0; i < len(nonce); i++ {
		if !isLarkDesktopNonceChar(nonce[i]) {
			return false
		}
	}

	return true
}

// isLarkDesktopNonceChar 判断字符是否属于 [A-Za-z0-9_-]。
func isLarkDesktopNonceChar(c byte) bool {
	switch {
	case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		return true
	case c == '-', c == '_':
		return true
	default:
		return false
	}
}

// writeLarkDesktopFailure 显示“飞书登录失败”错误页。
func writeLarkDesktopFailure(w http.ResponseWriter, status int, message string) {
	writeLarkDesktopPage(w, status, larkDesktopPage{Title: larkDesktopTitleFailed, Message: message})
}

// writeLarkDesktopPage 渲染结果页：不缓存、不带 Referer，CSP 只放行页面自带的样式和脚本。
func writeLarkDesktopPage(w http.ResponseWriter, status int, page larkDesktopPage) {
	var body bytes.Buffer
	if err := larkDesktopPageTemplate.Execute(&body, page); err != nil {
		slog.Error("render lark desktop login page", "error", errors.WithStack(err))
		http.Error(w, "failed to render page", http.StatusInternalServerError)
		return
	}

	header := w.Header()
	header.Set("Content-Type", larkDesktopContentType)
	header.Set("Cache-Control", larkDesktopCacheControl)
	header.Set("Referrer-Policy", larkDesktopReferrerPolicy)
	header.Set("X-Content-Type-Options", larkDesktopNoSniff)
	header.Set("Content-Security-Policy", larkDesktopPageCSP)
	w.WriteHeader(status)
	_, _ = w.Write(body.Bytes())
}

// cspScriptHash 返回 CSP script-src 用的脚本哈希。
func cspScriptHash(script string) string {
	sum := sha256.Sum256([]byte(script))

	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}

// put 为一次登录生成一次性 state 并保存。先清理过期的 state，达到上限时淘汰最早保存的一个。
func (s *larkDesktopStateStore) put(nonce, redirectURI string) (string, error) {
	if s == nil {
		return "", errLarkDesktopStatesUnavailable
	}

	raw := make([]byte, larkDesktopStateBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.WithStack(err)
	}
	state := base64.RawURLEncoding.EncodeToString(raw)

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock()
	s.dropExpiredLocked(now)

	if s.states == nil {
		s.states = make(map[string]larkDesktopState)
	}
	if len(s.states) >= larkDesktopMaxPendingStates {
		s.evictOldestLocked()
	}

	s.nextSeq++
	s.states[state] = larkDesktopState{
		nonce:       nonce,
		redirectURI: redirectURI,
		expiresAt:   now.Add(larkDesktopStateTTL),
		seq:         s.nextSeq,
	}

	return state, nil
}

// consume 取出并作废 state；不存在或已过期时 ok 为 false。
func (s *larkDesktopStateStore) consume(state string) (larkDesktopState, bool) {
	if s == nil || state == "" {
		return larkDesktopState{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.states[state]
	if !ok {
		return larkDesktopState{}, false
	}
	delete(s.states, state)

	if !s.clock().Before(entry.expiresAt) {
		return larkDesktopState{}, false
	}

	return entry, true
}

// pending 返回保存着的 state 数量。
func (s *larkDesktopStateStore) pending() int {
	if s == nil {
		return 0
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.states)
}

// clock 返回当前时间。
func (s *larkDesktopStateStore) clock() time.Time {
	if s.now != nil {
		return s.now()
	}

	return time.Now()
}

// dropExpiredLocked 删除已过期的 state，调用方需持有锁。
func (s *larkDesktopStateStore) dropExpiredLocked(now time.Time) {
	for state, entry := range s.states {
		if !now.Before(entry.expiresAt) {
			delete(s.states, state)
		}
	}
}

// evictOldestLocked 删除最早保存的 state，调用方需持有锁。
func (s *larkDesktopStateStore) evictOldestLocked() {
	var oldest string
	var oldestSeq uint64

	for state, entry := range s.states {
		if oldest == "" || entry.seq < oldestSeq {
			oldest, oldestSeq = state, entry.seq
		}
	}

	delete(s.states, oldest)
}
