package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"

	"github.com/yunboom/marvis/server/internal/logger"
)

// bootstrapAuthMethod tags the login in logs and the signup analytics event.
const bootstrapAuthMethod = "bootstrap"

// MinBootstrapTokenLength is the shortest MARVIS_BOOTSTRAP_TOKEN the server
// accepts; the desktop app generates a fresh random token on every start.
const MinBootstrapTokenLength = 32

// forwardingHeaders mark a request relayed by a proxy. A proxy on the same
// machine makes LAN requests look like loopback, so bootstrap refuses them.
var forwardingHeaders = []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP"}

// BootstrapLoginRequest is the body of POST /auth/bootstrap.
type BootstrapLoginRequest struct {
	Token string `json:"token"`
	Email string `json:"email"`
}

// BootstrapLogin signs the standalone host's admin in once. The desktop app
// starts the server with MARVIS_BOOTSTRAP_TOKEN and calls this from the same
// machine right after the server is ready, so the admin never needs a code.
//
// Only the TCP peer address counts as "the same machine", and a request that
// carries proxy forwarding headers is refused, because with LAN access on
// anyone on the network can reach this route, directly or through a proxy. A wrong token does not spend the one-time token; a successful login
// does, and a failure after the token matched gives it back.
func (h *Handler) BootstrapLogin(w http.ResponseWriter, r *http.Request) {
	if h.cfg.BootstrapToken == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) || hasForwardingHeader(r) {
		writeError(w, http.StatusForbidden, "bootstrap login is only available on this machine")
		return
	}

	var req BootstrapLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email, ok := canonicalBusinessEmail(req.Email)
	if !ok {
		writeError(w, http.StatusBadRequest, "email is invalid")
		return
	}

	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(h.cfg.BootstrapToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid bootstrap token")
		return
	}
	if !h.bootstrapUsed.CompareAndSwap(false, true) {
		writeError(w, http.StatusGone, "bootstrap token already used")
		return
	}

	user, tokenString, err := h.issueOAuthLogin(r, oauthLoginProfile{Email: email}, bootstrapAuthMethod)
	if err != nil {
		h.bootstrapUsed.Store(false)
		if writeGoogleLoginActionableError(w, err) {
			return
		}
		slog.Warn("bootstrap login failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		writeError(w, http.StatusInternalServerError, "failed to sign in")
		return
	}

	h.writeLoginSession(w, r, user, tokenString, bootstrapAuthMethod)
}

// hasForwardingHeader reports whether any proxy forwarding header is present.
func hasForwardingHeader(r *http.Request) bool {
	for _, name := range forwardingHeaders {
		if r.Header.Get(name) != "" {
			return true
		}
	}

	return false
}

// isLoopbackPeer reports whether a RemoteAddr ("host:port") is a loopback IP.
func isLoopbackPeer(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)

	return ip != nil && ip.IsLoopback()
}
