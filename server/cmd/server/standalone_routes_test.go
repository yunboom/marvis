package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yunboom/marvis/server/internal/analytics"
	"github.com/yunboom/marvis/server/internal/events"
	"github.com/yunboom/marvis/server/internal/realtime"
)

// standaloneTestToken is long enough to pass MinBootstrapTokenLength.
var standaloneTestToken = strings.Repeat("a1", 16)

func newStandaloneTestServer(t *testing.T, opts RouterOptions) *httptest.Server {
	t.Helper()

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, opts)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	return srv
}

func postJSONStatus(t *testing.T, url, body string) int {
	t.Helper()

	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	_ = resp.Body.Close()

	return resp.StatusCode
}

func TestBootstrapRouteRequiresStandaloneAndToken(t *testing.T) {
	const wrongTokenBody = `{"token":"wrong","email":"admin@example.com"}`

	cases := []struct {
		name string
		opts RouterOptions
		want int
	}{
		{"regular deployment", RouterOptions{BootstrapToken: standaloneTestToken}, http.StatusNotFound},
		{"standalone without token", RouterOptions{Standalone: true}, http.StatusNotFound},
		{"standalone with short token", RouterOptions{Standalone: true, BootstrapToken: "short"}, http.StatusNotFound},
		{"standalone with token", RouterOptions{Standalone: true, BootstrapToken: standaloneTestToken}, http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := newStandaloneTestServer(t, c.opts)
			if got := postJSONStatus(t, srv.URL+"/auth/bootstrap", wrongTokenBody); got != c.want {
				t.Fatalf("POST /auth/bootstrap = %d, want %d", got, c.want)
			}
		})
	}
}

// Standalone mode runs without Redis, where the Redis limiter fails open; the
// fixed login code must still not be guessable at full speed.
func TestStandaloneAuthRoutesRateLimitedWithoutRedis(t *testing.T) {
	t.Setenv("RATE_LIMIT_AUTH_VERIFY", "1")
	const body = `{"email":"nobody@example.com","code":"000000"}`

	standalone := newStandaloneTestServer(t, RouterOptions{Standalone: true})
	if got := postJSONStatus(t, standalone.URL+"/auth/verify-code", body); got == http.StatusTooManyRequests {
		t.Fatal("first standalone verify-code was rate limited")
	}
	if got := postJSONStatus(t, standalone.URL+"/auth/verify-code", body); got != http.StatusTooManyRequests {
		t.Fatalf("second standalone verify-code = %d, want 429", got)
	}

	regular := newStandaloneTestServer(t, RouterOptions{})
	postJSONStatus(t, regular.URL+"/auth/verify-code", body)
	if got := postJSONStatus(t, regular.URL+"/auth/verify-code", body); got == http.StatusTooManyRequests {
		t.Fatal("regular deployment without Redis started rate limiting")
	}
}
