package middleware

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// memoryRateLimitSweepSize is the number of tracked keys above which expired
// windows are swept on the next request, bounding memory under a scan.
const memoryRateLimitSweepSize = 10_000

// memoryWindow is one key's fixed window.
type memoryWindow struct {
	count   int
	resetAt time.Time
}

// MemoryRateLimit returns a per-IP fixed-window rate limiter kept in process
// memory. It exists for single-process deployments without Redis (desktop
// standalone mode), where RateLimit would otherwise fail open. Keys and the
// trustedProxies handling match RateLimit.
func MemoryRateLimit(limit int, window time.Duration, trustedProxies []*net.IPNet) func(http.Handler) http.Handler {
	var mu sync.Mutex
	windows := make(map[string]*memoryWindow)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := rateLimitKey(r.URL.Path, extractIP(r, trustedProxies))
			now := time.Now()

			mu.Lock()
			if len(windows) > memoryRateLimitSweepSize {
				for k, win := range windows {
					if !now.Before(win.resetAt) {
						delete(windows, k)
					}
				}
			}
			win, ok := windows[key]
			if !ok || !now.Before(win.resetAt) {
				win = &memoryWindow{resetAt: now.Add(window)}
				windows[key] = win
			}
			win.count++
			over := win.count > limit
			mu.Unlock()

			if over {
				writeTooManyRequests(w, window)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
