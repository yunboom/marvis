package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yunboom/marvis/server/internal/analytics"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

const bootstrapTestToken = "bootstrap-test-token"

// newBootstrapHandler builds a handler of its own so each test starts with an
// unused one-time bootstrap token.
func newBootstrapHandler(t *testing.T, token string) *Handler {
	t.Helper()

	return New(db.New(testPool), testPool, testHandler.Hub, testHandler.Bus, testHandler.EmailService, nil, nil, analytics.NoopClient{}, Config{AllowSignup: true, BootstrapToken: token})
}

func bootstrapRequest(t *testing.T, remoteAddr, token, email string) *http.Request {
	t.Helper()

	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(BootstrapLoginRequest{Token: token, Email: email}); err != nil {
		t.Fatalf("encode bootstrap request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/auth/bootstrap", &buf)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remoteAddr

	return req
}

func cleanupBootstrapUser(t *testing.T, email string) {
	t.Helper()

	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE email = $1`, email)
	})
}

func TestBootstrapLoginCreatesUserAndSession(t *testing.T) {
	const email = "bootstrap-create@marvis.ai"
	cleanupBootstrapUser(t, email)
	h := newBootstrapHandler(t, bootstrapTestToken)

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, email))
	if w.Code != http.StatusOK {
		t.Fatalf("BootstrapLogin: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp LoginResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("BootstrapLogin: expected a token")
	}
	if !strings.Contains(strings.Join(w.Header().Values("Set-Cookie"), "\n"), "=") {
		t.Fatal("BootstrapLogin: expected auth cookies")
	}

	var count int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM "user" WHERE email = $1`, email).Scan(&count); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 user for %s, got %d", email, count)
	}
}

func TestBootstrapLoginIsSingleUse(t *testing.T) {
	const email = "bootstrap-single@marvis.ai"
	cleanupBootstrapUser(t, email)
	h := newBootstrapHandler(t, bootstrapTestToken)

	first := httptest.NewRecorder()
	h.BootstrapLogin(first, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, email))
	if first.Code != http.StatusOK {
		t.Fatalf("first BootstrapLogin: expected 200, got %d: %s", first.Code, first.Body.String())
	}

	second := httptest.NewRecorder()
	h.BootstrapLogin(second, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, email))
	if second.Code != http.StatusGone {
		t.Fatalf("second BootstrapLogin: expected 410, got %d: %s", second.Code, second.Body.String())
	}

	// Two concurrent calls on a fresh handler: exactly one wins.
	concurrent := newBootstrapHandler(t, bootstrapTestToken)
	codes := make([]int, 2)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			concurrent.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, email))
			codes[i] = w.Code
		}()
	}
	wg.Wait()

	ok := 0
	for _, code := range codes {
		if code == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("concurrent BootstrapLogin: expected exactly one 200, got codes %v", codes)
	}
}

func TestBootstrapLoginRejectsNonLoopback(t *testing.T) {
	h := newBootstrapHandler(t, bootstrapTestToken)

	req := bootstrapRequest(t, "192.168.1.37:50000", bootstrapTestToken, "bootstrap-lan@marvis.ai")
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	req.Header.Set("X-Real-IP", "127.0.0.1")

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("BootstrapLogin from LAN: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBootstrapLoginRejectsWrongToken(t *testing.T) {
	const email = "bootstrap-wrong@marvis.ai"
	cleanupBootstrapUser(t, email)
	h := newBootstrapHandler(t, bootstrapTestToken)

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", "not-the-token", email))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("BootstrapLogin wrong token: expected 401, got %d: %s", w.Code, w.Body.String())
	}

	// A wrong token does not spend the one-time token.
	w = httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, email))
	if w.Code != http.StatusOK {
		t.Fatalf("BootstrapLogin after wrong token: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBootstrapLoginRejectsInvalidEmail(t *testing.T) {
	h := newBootstrapHandler(t, bootstrapTestToken)

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", bootstrapTestToken, "not-an-email"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("BootstrapLogin invalid email: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBootstrapLoginNotConfigured(t *testing.T) {
	h := newBootstrapHandler(t, "")

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "127.0.0.1:50000", "", "bootstrap-off@marvis.ai"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("BootstrapLogin without token configured: expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBootstrapLoginAcceptsIPv6Loopback(t *testing.T) {
	const email = "bootstrap-ipv6@marvis.ai"
	cleanupBootstrapUser(t, email)
	h := newBootstrapHandler(t, bootstrapTestToken)

	w := httptest.NewRecorder()
	h.BootstrapLogin(w, bootstrapRequest(t, "[::1]:50000", bootstrapTestToken, email))
	if w.Code != http.StatusOK {
		t.Fatalf("BootstrapLogin over IPv6 loopback: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
