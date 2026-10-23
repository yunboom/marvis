package main

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// maxLANTextRunes 是局域网或 /api/config 给出的文本（服务器名称、版本等）显示时的长度上限。
	maxLANTextRunes = 64
	// truncationMark 接在被截断的文本末尾。
	truncationMark = "…"

	// mdnsHostSuffix 是 mDNS 主机名的后缀；这类地址要靠组播解析，耗时可能超过普通请求的超时。
	mdnsHostSuffix = ".local"
	// mdnsProbeTimeout 是请求 .local 地址时的超时，给组播解析留出时间。
	mdnsProbeTimeout = 6 * time.Second

	// hostnameLocalhost 是指向本机的主机名。
	hostnameLocalhost = "localhost"
)

// bidiControls 是会改变文字显示顺序的 Unicode 方向控制符，可用来伪装显示内容，一律去掉。
var bidiControls = map[rune]struct{}{
	'\u061c': {}, // ARABIC LETTER MARK
	'\u200e': {}, // LEFT-TO-RIGHT MARK
	'\u200f': {}, // RIGHT-TO-LEFT MARK
	'\u202a': {}, // LEFT-TO-RIGHT EMBEDDING
	'\u202b': {}, // RIGHT-TO-LEFT EMBEDDING
	'\u202c': {}, // POP DIRECTIONAL FORMATTING
	'\u202d': {}, // LEFT-TO-RIGHT OVERRIDE
	'\u202e': {}, // RIGHT-TO-LEFT OVERRIDE
	'\u2066': {}, // LEFT-TO-RIGHT ISOLATE
	'\u2067': {}, // RIGHT-TO-LEFT ISOLATE
	'\u2068': {}, // FIRST STRONG ISOLATE
	'\u2069': {}, // POP DIRECTIONAL ISOLATE
}

// sanitizeLANText 清理局域网广播或 /api/config 给出的文本，再用于终端输出或保存：
// 先按 stripUnsafeRunes 去掉不安全的字符和首尾空白，超过 maxLANTextRunes 个字符时截断并加省略号。
func sanitizeLANText(s string) string {
	cleaned := stripUnsafeRunes(s)
	if utf8.RuneCountInString(cleaned) <= maxLANTextRunes {
		return cleaned
	}

	runes := []rune(cleaned)

	return string(runes[:maxLANTextRunes-1]) + truncationMark
}

// stripUnsafeRunes 去掉非法 UTF-8、C0/C1 控制字符（含终端转义序列的 ESC）和方向控制符，再去掉首尾空白。
func stripUnsafeRunes(s string) string {
	s = strings.ToValidUTF8(s, "")

	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}

		if _, bidi := bidiControls[r]; bidi {
			continue
		}

		b.WriteRune(r)
	}

	return strings.TrimSpace(b.String())
}

// urlHostname 把广播的主机名规整为可以放进地址的形式：去掉末尾的点并转小写，
// 只允许 a-z、0-9、点和连字符，且不能以点开头。不合规时返回 false。
func urlHostname(host string) (string, bool) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || strings.HasPrefix(host, ".") {
		return "", false
	}

	for _, r := range host {
		valid := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-'
		if !valid {
			return "", false
		}
	}

	return host, true
}

// probeTimeoutFor 返回请求 baseURL 的超时：.local 主机名用 mdnsProbeTimeout，其余用 fallback。
func probeTimeoutFor(baseURL string, fallback time.Duration) time.Duration {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return fallback
	}

	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if strings.HasSuffix(host, mdnsHostSuffix) {
		return mdnsProbeTimeout
	}

	return fallback
}

// listLocalAddrs 返回本机所有网卡上的地址，取不到时返回空。
func listLocalAddrs() []net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}

	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok {
			ips = append(ips, ipNet.IP)
		}
	}

	return ips
}

// lookupHostIPs 解析主机名得到地址。
func lookupHostIPs(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}

	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		ips = append(ips, addr.IP)
	}

	return ips, nil
}

// isLocalServer 判断服务器是否就在本机：主机是 localhost 或回环地址，或者主机（解析后）是本机网卡上的地址。
// 解析失败按不在本机处理。
func isLocalServer(ctx context.Context, deps discoverDeps, serverURL string) bool {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return false
	}

	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == hostnameLocalhost {
		return true
	}

	candidates := []net.IP{net.ParseIP(host)}
	if candidates[0] == nil {
		ctx, cancel := context.WithTimeout(ctx, probeTimeoutFor(serverURL, identityTimeout))
		defer cancel()

		resolved, err := deps.lookupHost(ctx, host)
		if err != nil {
			return false
		}

		candidates = resolved
	}

	local := deps.localAddrs()
	for _, ip := range candidates {
		if ip.IsLoopback() || containsIP(local, ip) {
			return true
		}
	}

	return false
}

// containsIP 判断 ips 里是否有与 target 相同的地址。
func containsIP(ips []net.IP, target net.IP) bool {
	for _, ip := range ips {
		if ip.Equal(target) {
			return true
		}
	}

	return false
}

// normalizeWebAppURL 规整 /api/config 的 daemon_app_url：必须是 http(s) 地址且不含控制字符，
// 去掉首尾空白和末尾斜杠。回环地址保留，是否可用由 webAppURLFor 按服务器是否在本机判断。
func normalizeWebAppURL(daemonAppURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(daemonAppURL), "/")
	if trimmed == "" || sanitizeLANText(trimmed) != trimmed {
		return ""
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return ""
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != urlSchemeHTTP && scheme != urlSchemeHTTPS {
		return ""
	}

	return trimmed
}

// webAppURLFor 决定所选服务器的网页端地址。主机是回环地址（localhost、127.0.0.1、::1）的网页端
// 只在服务器所在机器上打得开：服务器就在本机时采用，否则按没有网页端处理，返回空字符串。
func webAppURLFor(appURL string, serverIsLocal bool) string {
	if appURL == "" || serverIsLocal {
		return appURL
	}

	// serverHostIsLocal 区分大小写，主机名统一转小写后再判断。
	if serverHostIsLocal(strings.ToLower(appURL)) {
		return ""
	}

	return appURL
}

// selfHostLoginInput 是决定 setup self-host 网页端地址和登录方式所需的输入。
type selfHostLoginInput struct {
	// ExplicitAppURL 来自 --app-url 或 MARVIS_APP_URL。
	ExplicitAppURL string
	// ConfiguredAppURL 是 resolveSelfHostAppURL 的结果：参数、环境变量或已有配置。
	ConfiguredAppURL string
	// Picked 是选择流程选定的服务器，没有走选择流程时为 nil。
	Picked *discoveredServer
	// ServerURL 是将要写入的服务器地址。
	ServerURL string
	// UserProvidedServerURL 为 true 表示服务器地址来自参数、环境变量或已有配置。
	UserProvidedServerURL bool
	// FrontendPort 是 --frontend-port 的值。
	FrontendPort int
}

// selfHostLogin 是 setup self-host 的网页端地址和登录方式。
type selfHostLogin struct {
	// AppURL 是网页端地址，为空表示没有网页端。
	AppURL string
	// AskAppURL 为 true 表示服务器在远端又没有网页端地址，需要询问用户。
	AskAppURL bool
}

// BrowserLogin 返回是否走浏览器登录并启动守护进程；没有网页端时改为提示用令牌登录。
func (l selfHostLogin) BrowserLogin() bool {
	return l.AppURL != ""
}

// resolveSelfHostLogin 决定网页端地址和登录方式：
//   - 走了选择流程：--app-url / MARVIS_APP_URL 优先，否则取所选服务器 /api/config 的网页端地址，
//     回环地址只在服务器就在本机时采用；都没有时不走浏览器登录；
//   - 没走选择流程：用参数、环境变量或已有配置里的网页端地址；服务器在远端时需要询问；
//     本机服务器退回 http://localhost:<frontend-port>。
func resolveSelfHostLogin(in selfHostLoginInput) selfHostLogin {
	if in.Picked != nil {
		if in.ExplicitAppURL != "" {
			return selfHostLogin{AppURL: in.ExplicitAppURL}
		}

		return selfHostLogin{AppURL: webAppURLFor(in.Picked.AppURL, in.Picked.Local)}
	}

	if in.ConfiguredAppURL != "" {
		return selfHostLogin{AppURL: in.ConfiguredAppURL}
	}

	if in.UserProvidedServerURL && !serverHostIsLocal(in.ServerURL) {
		return selfHostLogin{AskAppURL: true}
	}

	return selfHostLogin{AppURL: fmt.Sprintf("http://%s:%d", hostnameLocalhost, in.FrontendPort)}
}
