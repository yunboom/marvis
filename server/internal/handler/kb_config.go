package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// reservedKbSlugs are slugs a knowledge base cannot take because they are
// route segments under /{workspace}/kb.
var reservedKbSlugs = map[string]bool{
	"new": true,
}

// mentionLabelEscaper keeps a knowledge base name from breaking the
// [label](mention://…) Markdown.
var mentionLabelEscaper = strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`)

// CreateKbBaseRequest creates a knowledge base. Schema is only allowed (and
// then required) in the custom schema mode.
type CreateKbBaseRequest struct {
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description string  `json:"description"`
	Purpose     string  `json:"purpose"`
	SchemaMode  string  `json:"schema_mode"`
	Schema      *string `json:"schema"`
}

// UpdateKbBaseRequest changes a knowledge base's configuration; omitted
// fields keep their value.
type UpdateKbBaseRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Purpose     *string `json:"purpose"`
	SchemaMode  *string `json:"schema_mode"`
	Schema      *string `json:"schema"`
	// BaseUpdatedAt is the updated_at the editor opened; a later save by
	// someone else answers 409.
	BaseUpdatedAt *string `json:"base_updated_at"`
}

// KbBaseMutationResponse is a created or updated knowledge base with the
// mention a reply can paste to render its card.
type KbBaseMutationResponse struct {
	KbBaseResponse
	Mention string `json:"mention"`
}

func kbMention(base db.KbBase) string {
	return "[" + mentionLabelEscaper.Replace(base.Name) + "](mention://kb/" + uuidToString(base.ID) + ")"
}

// CreateKbBase creates a knowledge base and its first configuration revision
// in one transaction. The default schema mode writes the built-in schema as
// it is today; later template changes do not touch existing bases.
func (h *Handler) CreateKbBase(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}

	var req CreateKbBaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	slug := strings.ToLower(strings.TrimSpace(req.Slug))
	if name == "" || slug == "" {
		writeError(w, http.StatusBadRequest, "name and slug are required")
		return
	}
	if !workspaceSlugPattern.MatchString(slug) {
		writeError(w, http.StatusBadRequest, "slug must contain only lowercase letters, numbers, and hyphens")
		return
	}
	if reservedKbSlugs[slug] {
		writeError(w, http.StatusBadRequest, "slug is reserved")
		return
	}
	schema, msg := kbSchemaFor(req.SchemaMode, req.Schema)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin knowledge base create"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	qtx := h.Queries.WithTx(tx)

	base, err := qtx.CreateKbBase(r.Context(), db.CreateKbBaseParams{
		WorkspaceID: wsUUID,
		Name:        name,
		Slug:        slug,
		Description: strings.TrimSpace(req.Description),
		SchemaMode:  req.SchemaMode,
		Purpose:     req.Purpose,
		Schema:      schema,
		CreatedBy:   parseUUID(userID),
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a knowledge base with this slug already exists")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create knowledge base slug=%q", slug))
		return
	}
	if err := writeKbConfigRevision(r, qtx, base, userID); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit knowledge base create"))
		return
	}

	writeJSON(w, http.StatusCreated, KbBaseMutationResponse{
		KbBaseResponse: kbBaseToResponse(base, kbBaseStats{}),
		Mention:        kbMention(base),
	})
}

// UpdateKbBase saves a knowledge base's configuration (name, description,
// purpose, schema). It takes effect immediately, without a merge request,
// and every save writes a configuration revision.
func (h *Handler) UpdateKbBase(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req UpdateKbBaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var openedAt time.Time
	if req.BaseUpdatedAt != nil {
		parsed, err := time.Parse(time.RFC3339Nano, *req.BaseUpdatedAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "base_updated_at must be an RFC3339 timestamp")
			return
		}
		openedAt = parsed
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name cannot be empty")
		return
	}

	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, h.resolveWorkspaceID(r))
	if !ok {
		return
	}
	if !canConfigureKb(member, base) {
		writeError(w, http.StatusForbidden, "only the knowledge base creator or a workspace owner or admin can configure it")
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin knowledge base update"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.GetKbBaseForUpdate(r.Context(), db.GetKbBaseForUpdateParams{WorkspaceID: base.WorkspaceID, ID: base.ID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "knowledge base not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "lock knowledge base knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	// updated_at reaches clients at second precision, so compare at that
	// precision.
	if req.BaseUpdatedAt != nil && !locked.UpdatedAt.Time.Truncate(time.Second).Equal(openedAt.Truncate(time.Second)) {
		writeError(w, http.StatusConflict, "the configuration was saved by someone else after you opened it")
		return
	}

	params, msg := kbConfigUpdate(locked, req)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	updated, err := qtx.UpdateKbBaseConfig(r.Context(), params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "update knowledge base knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	if err := writeKbConfigRevision(r, qtx, updated, userID); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit knowledge base update"))
		return
	}

	stats, err := h.loadKbBaseStats(r.Context(), updated.WorkspaceID, []db.KbBase{updated})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, KbBaseMutationResponse{
		KbBaseResponse: kbBaseToResponse(updated, stats),
		Mention:        kbMention(updated),
	})
}

// kbSchemaFor resolves the schema text a new knowledge base stores. It
// returns a client error message when the mode and schema do not fit.
func kbSchemaFor(mode string, schema *string) (string, string) {
	switch mode {
	case kb.SchemaModeDefault:
		if schema != nil {
			return "", "schema is not allowed with the default schema mode"
		}

		return kb.DefaultSchema, ""
	case kb.SchemaModeCustom:
		if schema == nil || strings.TrimSpace(*schema) == "" {
			return "", "schema is required with the custom schema mode"
		}

		return *schema, ""
	default:
		return "", "schema_mode must be default or custom"
	}
}

// kbConfigUpdate merges a configuration save into the current row. Switching
// to the default mode puts back today's built-in schema; staying in it keeps
// the schema written at creation. It returns a client error message when the
// mode and schema do not fit.
func kbConfigUpdate(base db.KbBase, req UpdateKbBaseRequest) (db.UpdateKbBaseConfigParams, string) {
	params := db.UpdateKbBaseConfigParams{
		ID:          base.ID,
		Name:        base.Name,
		Description: base.Description,
		SchemaMode:  base.SchemaMode,
		Purpose:     base.Purpose,
		Schema:      base.Schema,
	}
	if req.Name != nil {
		params.Name = strings.TrimSpace(*req.Name)
	}
	if req.Description != nil {
		params.Description = strings.TrimSpace(*req.Description)
	}
	if req.Purpose != nil {
		params.Purpose = *req.Purpose
	}
	if req.SchemaMode != nil {
		params.SchemaMode = *req.SchemaMode
	}

	switch params.SchemaMode {
	case kb.SchemaModeDefault:
		if req.Schema != nil {
			return params, "schema is not allowed with the default schema mode"
		}
		if base.SchemaMode != kb.SchemaModeDefault {
			params.Schema = kb.DefaultSchema
		}
	case kb.SchemaModeCustom:
		if req.Schema != nil {
			if strings.TrimSpace(*req.Schema) == "" {
				return params, "schema cannot be empty"
			}
			params.Schema = *req.Schema
		} else if base.SchemaMode != kb.SchemaModeCustom {
			return params, "schema is required when switching to the custom schema mode"
		}
	default:
		return params, "schema_mode must be default or custom"
	}

	return params, ""
}

// writeKbConfigRevision records the configuration a knowledge base now has.
func writeKbConfigRevision(r *http.Request, q *db.Queries, base db.KbBase, userID string) error {
	if _, err := q.CreateKbConfigRevision(r.Context(), db.CreateKbConfigRevisionParams{
		KnowledgeBaseID: base.ID,
		Name:            base.Name,
		Description:     base.Description,
		SchemaMode:      base.SchemaMode,
		Purpose:         base.Purpose,
		Schema:          base.Schema,
		SavedBy:         parseUUID(userID),
	}); err != nil {
		return errors.Wrapf(err, "write config revision knowledge_base_id=%s", uuidToString(base.ID))
	}

	return nil
}
