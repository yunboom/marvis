package handler

import (
	"net/http"

	"github.com/pkg/errors"
)

// Machine-readable error codes of the knowledge base draft endpoints; the
// CLI prints them as {"error": {"code", "message"}}.
const (
	kbCodeStaleVersion     = "stale_version"
	kbCodeConflictMarkers  = "conflict_markers"
	kbCodeStrReplaceMatch  = "str_replace_match"
	kbCodeDuplicateSlug    = "duplicate_slug"
	kbCodeDraftNotOpen     = "draft_not_open"
	kbCodeBlockNotFound    = "block_not_found"
	kbCodePageNotFound     = "page_not_found"
	kbCodePageHasChildren  = "page_has_children"
	kbCodeInvalidRequest   = "invalid_request"
	kbCodeForbidden        = "forbidden"
	kbCodeJobNotFound      = "job_not_found"
	kbCodeJobDraftExists   = "job_draft_exists"
	kbCodeChatScopeDenied  = "chat_scope_forbidden"
	kbCodeDraftNotFound    = "draft_not_found"
	kbCodeKnowledgeBaseNF  = "knowledge_base_not_found"
	kbCodeProtectedMetaKey = "protected_meta_key"
)

// kbRequestError is an expected failure of a knowledge base request (a 4xx
// with a code). Handlers return it from inner steps and writeKbError renders
// it; anything else is an internal error.
type kbRequestError struct {
	status  int
	code    string
	message string
	// extra fields merged into the error body, such as the linked draft_id
	// of job_draft_exists.
	extra map[string]any
}

func (e *kbRequestError) Error() string {
	return e.code + ": " + e.message
}

func kbFail(status int, code, message string) error {
	return &kbRequestError{status: status, code: code, message: message}
}

// writeKbError renders a kbRequestError, or logs and answers 500 for any
// other error.
func (h *Handler) writeKbError(w http.ResponseWriter, r *http.Request, err error) {
	var reqErr *kbRequestError
	if !errors.As(err, &reqErr) {
		h.writeKbInternalError(w, r, err)
		return
	}

	body := map[string]any{"error": reqErr.message, "code": reqErr.code}
	for k, v := range reqErr.extra {
		body[k] = v
	}
	writeJSON(w, reqErr.status, body)
}
