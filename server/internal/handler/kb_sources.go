package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbSourceKindComment is an issue comment in GET /api/kb/sources; its uri is
// the issue's task:// uri with a #comment-<id> fragment.
const kbSourceKindComment = "comment"

// kbSourceKinds are the kinds GET /api/kb/sources lists, in the order the
// kinds parameter documents them.
var kbSourceKinds = []string{kb.SourceKindTask, kbSourceKindComment, kb.SourceKindChat, kb.SourceKindRaw}

// kbIngestibleChatSources are the chat_session sources whose conversations a
// knowledge base may ingest: ordinary chats and autopilot run follow-up chats.
// A job's own chat and builder conversations are working material, not
// knowledge.
var kbIngestibleChatSources = []string{protocol.ChatSessionSourceChat, protocol.ChatSessionSourceAutopilotRun}

// KbSource is one item of material a knowledge base can ingest.
type KbSource struct {
	URI       string `json:"uri"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updated_at"`
	Ingested  bool   `json:"ingested"`
	// ReadWith is the existing CLI command that reads the material.
	ReadWith string `json:"read_with"`
}

// ListKbSources lists the issues, comments, chats and raw files a knowledge
// base can ingest (spec 7.13). Chats follow the chat read rules: the
// caller's own, or every member's public chat for a caller allowed to read
// them all (spec 8.7).
func (h *Handler) ListKbSources(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	query := r.URL.Query()
	ref := strings.TrimSpace(query.Get("kb"))
	if ref == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "kb is required")
		return
	}
	base, ok := h.loadKbBaseForUser(w, r, ref)
	if !ok {
		return
	}
	want, ok := parseKbSourceKinds(w, query.Get("kinds"))
	if !ok {
		return
	}
	var since pgtype.Timestamptz
	if raw := query.Get("since"); raw != "" {
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "since must be an RFC3339 time")
			return
		}
		since = pgtype.Timestamptz{Time: t, Valid: true}
	}
	includeIngested := false
	if raw := query.Get("ingested"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "ingested must be true or false")
			return
		}
		includeIngested = v
	}
	limit, offset, ok := parseKbPaging(w, query.Get("limit"), query.Get("offset"), kbListDefaultLimit, kbListMaxLimit)
	if !ok {
		return
	}

	readAll, err := h.chatWorkspaceReadAllowed(r, userID, workspaceID, member)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	chatCreator := parseUUID(userID)
	if readAll {
		chatCreator = pgtype.UUID{}
	}

	rows, err := h.Queries.ListKbSources(r.Context(), db.ListKbSourcesParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Since:           since,
		WantTask:        want[kb.SourceKindTask],
		WantComment:     want[kbSourceKindComment],
		WantChat:        want[kb.SourceKindChat],
		WantRaw:         want[kb.SourceKindRaw],
		ChatCreator:     chatCreator,
		ChatSources:     kbIngestibleChatSources,
		IncludeIngested: includeIngested,
		RowLimit:        int32(limit),
		RowOffset:       int32(offset),
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list sources knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	out := make([]KbSource, 0, len(rows))
	for _, row := range rows {
		out = append(out, KbSource{
			URI:       row.Uri,
			Kind:      row.Kind,
			Title:     row.Title,
			UpdatedAt: timestampToString(row.UpdatedAt),
			Ingested:  row.Ingested,
			ReadWith:  kbSourceReadCommand(row.Kind, row.Ref, base.Slug, readAll),
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// parseKbSourceKinds reads the comma separated kinds parameter; empty means
// every kind.
func parseKbSourceKinds(w http.ResponseWriter, raw string) (map[string]bool, bool) {
	want := make(map[string]bool, len(kbSourceKinds))
	if strings.TrimSpace(raw) == "" {
		for _, kind := range kbSourceKinds {
			want[kind] = true
		}

		return want, true
	}

	known := make(map[string]bool, len(kbSourceKinds))
	for _, kind := range kbSourceKinds {
		known[kind] = true
	}
	for _, part := range strings.Split(raw, ",") {
		kind := strings.TrimSpace(part)
		if !known[kind] {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "kinds must be a comma separated list of task, comment, chat and raw")
			return nil, false
		}
		want[kind] = true
	}

	return want, true
}

// kbSourceReadCommand is the existing command an agent reads a source with.
func kbSourceReadCommand(kind, ref, kbSlug string, workspaceScope bool) string {
	switch kind {
	case kb.SourceKindTask:
		return "marvis issue get " + ref
	case kbSourceKindComment:
		return "marvis issue comment list " + ref
	case kb.SourceKindChat:
		if workspaceScope {
			return "marvis chat get " + ref + " --scope workspace"
		}

		return "marvis chat get " + ref
	case kb.SourceKindRaw:
		return "marvis kb raw get " + kbSlug + " " + ref
	default:
		return ""
	}
}
