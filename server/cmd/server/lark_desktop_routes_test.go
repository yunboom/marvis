package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/yunboom/marvis/server/internal/analytics"
	"github.com/yunboom/marvis/server/internal/events"
	"github.com/yunboom/marvis/server/internal/handler"
	"github.com/yunboom/marvis/server/internal/landiscovery"
	"github.com/yunboom/marvis/server/internal/realtime"
)

// larkDesktopRoutesRedisDB 是本文件 Redis 测试使用的逻辑库，与其他包的测试错开。
const larkDesktopRoutesRedisDB = 10

// larkDesktopRoutesTestNonce 是一个合法的桌面端 nonce。
var larkDesktopRoutesTestNonce = strings.Repeat("aB3_-", 8)

// larkDesktopRoutePaths 是桌面端飞书登录的两个浏览器地址。
var larkDesktopRoutePaths = []string{handler.LarkDesktopStartPath, handler.LarkDesktopCallbackPath}

// noRedirectClient 不跟随跳转，用来读取 302 的 Location。
var noRedirectClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// unsetLarkLogin 让飞书登录处于未配置状态。
func unsetLarkLogin(t *testing.T) {
	t.Helper()

	t.Setenv("MARVIS_LARK_LOGIN_APP_ID", "")
	t.Setenv("MARVIS_LARK_LOGIN_APP_SECRET", "")
	t.Setenv("MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI", "")
}

// getStatus 发起 GET 请求，返回状态码和响应头。
func getStatus(t *testing.T, client *http.Client, rawURL string) (int, http.Header) {
	t.Helper()

	resp, err := client.Get(rawURL)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	_ = resp.Body.Close()

	return resp.StatusCode, resp.Header
}

func TestLarkDesktopLoginRoutesArePublic(t *testing.T) {
	unsetLarkLogin(t)

	for _, path := range larkDesktopRoutePaths {
		t.Run(path, func(t *testing.T) {
			status, header := getStatus(t, http.DefaultClient, testServer.URL+path)

			// 飞书未配置：不经登录中间件，直接由处理函数显示“未配置”页面。
			if status != http.StatusForbidden || !strings.HasPrefix(header.Get("Content-Type"), "text/html") {
				t.Fatalf("GET %s = %d %q, want the 403 HTML page from the handler", path, status, header.Get("Content-Type"))
			}
		})
	}
}

func TestLarkDesktopLoginRoutesAreRateLimited(t *testing.T) {
	rdb := newLarkDesktopRoutesRedis(t)
	unsetLarkLogin(t)
	t.Setenv("RATE_LIMIT_AUTH", "1")

	router := NewRouter(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, rdb)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	for _, path := range larkDesktopRoutePaths {
		t.Run(path, func(t *testing.T) {
			if status, _ := getStatus(t, http.DefaultClient, srv.URL+path); status == http.StatusTooManyRequests {
				t.Fatalf("first GET %s was rate limited", path)
			}
			if status, _ := getStatus(t, http.DefaultClient, srv.URL+path); status != http.StatusTooManyRequests {
				t.Fatalf("second GET %s = %d, want 429 from the auth rate limiter", path, status)
			}
		})
	}
}

func TestLarkDesktopLoginUsesAdvertisedHostname(t *testing.T) {
	t.Setenv("MARVIS_LARK_LOGIN_APP_ID", "cli_desktop_test")
	t.Setenv("MARVIS_LARK_LOGIN_APP_SECRET", "desktop-secret")
	t.Setenv("MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI", "")

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{
		LAN:         landiscovery.Config{Name: "studio", Port: 13900},
		LANHostname: func() string { return "marvis-2.local" },
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	status, header := getStatus(t, noRedirectClient, srv.URL+handler.LarkDesktopStartPath+"?nonce="+larkDesktopRoutesTestNonce)
	if status != http.StatusFound {
		t.Fatalf("desktop-start = %d, want a redirect to Feishu", status)
	}
	location, err := url.Parse(header.Get("Location"))
	if err != nil {
		t.Fatalf("parse Location: %v", err)
	}
	if got, want := location.Query().Get("redirect_uri"), "http://marvis-2.local:13900"+handler.LarkDesktopCallbackPath; got != want {
		t.Fatalf("redirect_uri = %q, want %q", got, want)
	}

	resp, err := http.Get(srv.URL + "/api/config")
	if err != nil {
		t.Fatalf("GET /api/config: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var cfg map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode /api/config: %v", err)
	}
	if cfg["lark_desktop_login"] != true {
		t.Fatalf("lark_desktop_login = %v, want true", cfg["lark_desktop_login"])
	}
}

// newLarkDesktopRoutesRedis 连接 REDIS_TEST_URL 指向的本机 Redis，未设置或连不上时跳过。
func newLarkDesktopRoutesRedis(t *testing.T) *redis.Client {
	t.Helper()

	rawURL := os.Getenv("REDIS_TEST_URL")
	if rawURL == "" {
		t.Skip("REDIS_TEST_URL not set")
	}

	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		t.Fatalf("parse REDIS_TEST_URL: %v", err)
	}
	opts.DB = larkDesktopRoutesRedisDB

	rdb := redis.NewClient(opts)
	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("REDIS_TEST_URL unreachable: %v", err)
	}
	if err := rdb.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis db %d: %v", larkDesktopRoutesRedisDB, err)
	}
	t.Cleanup(func() {
		_ = rdb.FlushDB(context.Background()).Err()
		_ = rdb.Close()
	})

	return rdb
}
