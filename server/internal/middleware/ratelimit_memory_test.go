package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func memoryLimitedHandler(limit int, window time.Duration) http.Handler {
	return MemoryRateLimit(limit, window, nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func memoryLimitedStatus(h http.Handler, path, remoteAddr string) int {
	req := httptest.NewRequest(http.MethodPost, path, nil)
	req.RemoteAddr = remoteAddr
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	return w.Code
}

func TestMemoryRateLimitBlocksAfterLimit(t *testing.T) {
	h := memoryLimitedHandler(2, time.Minute)

	for i := range 2 {
		if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50000"); got != http.StatusOK {
			t.Fatalf("request %d = %d, want 200", i+1, got)
		}
	}
	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50001"); got != http.StatusTooManyRequests {
		t.Fatalf("request over the limit = %d, want 429", got)
	}
}

func TestMemoryRateLimitKeysByIPAndPath(t *testing.T) {
	h := memoryLimitedHandler(1, time.Minute)

	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50000"); got != http.StatusOK {
		t.Fatalf("first IP = %d, want 200", got)
	}
	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.38:50000"); got != http.StatusOK {
		t.Fatalf("second IP = %d, want 200", got)
	}
	if got := memoryLimitedStatus(h, "/auth/send-code", "192.168.1.37:50000"); got != http.StatusOK {
		t.Fatalf("other path = %d, want 200", got)
	}
}

func TestMemoryRateLimitResetsAfterWindow(t *testing.T) {
	h := memoryLimitedHandler(1, 50*time.Millisecond)

	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50000"); got != http.StatusOK {
		t.Fatalf("first request = %d, want 200", got)
	}
	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50000"); got != http.StatusTooManyRequests {
		t.Fatalf("second request = %d, want 429", got)
	}
	time.Sleep(80 * time.Millisecond)
	if got := memoryLimitedStatus(h, "/auth/verify-code", "192.168.1.37:50000"); got != http.StatusOK {
		t.Fatalf("request after the window = %d, want 200", got)
	}
}
