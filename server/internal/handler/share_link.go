package handler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/logger"
	"github.com/yunboom/marvis/server/internal/seatcapacity"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// expiresInMaxHours is the largest hour count that can be multiplied by
// time.Hour without overflowing a signed 64-bit time.Duration. Rejecting
// anything above it prevents expires_in from wrapping to a negative duration
// (which would make a freshly created link instantly expired).
const expiresInMaxHours = math.MaxInt64 / int64(time.Hour)

// ShareLinkResponse is the JSON shape returned for a workspace share link.
type ShareLinkResponse struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspace_id"`
	Code        string  `json:"code"`
	CreatedBy   string  `json:"created_by"`
	Role        string  `json:"role"`
	ExpiresAt   *string `json:"expires_at,omitempty"`
	MaxUses     *int32  `json:"max_uses,omitempty"`
	UseCount    int32   `json:"use_count"`
	IsActive    bool    `json:"is_active"`
	CreatedAt   string  `json:"created_at"`
	// Enriched
	CreatorName  string `json:"creator_name,omitempty"`
	CreatorEmail string `json:"creator_email,omitempty"`
}

type CreateShareLinkRequest struct {
	Role      string `json:"role"`
	ExpiresIn *int   `json:"expires_in,omitempty"` // hours from now
	MaxUses   *int   `json:"max_uses,omitempty"`
}

type JoinByShareLinkRequest struct {
	Code string `json:"code"`
}

func generateShareCode() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// CreateShareLink — admin creates a shareable invite link.
// POST /api/workspaces/{id}/share-links
func (h *Handler) CreateShareLink(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	requester, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	var req CreateShareLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	role := "member"
	if req.Role != "" {
		r := strings.ToLower(strings.TrimSpace(req.Role))
		if r == "admin" {
			role = "admin"
		} else if r != "member" {
			writeError(w, http.StatusBadRequest, "invalid role")
			return
		}
	}

	// Validate expiry and usage bounds instead of silently treating bad input
	// as "no limit": zero/negative and overflow-range values are rejected
	// outright. max_uses is stored as int32, and expires_in is multiplied by
	// time.Hour into a time.Duration, so both need an explicit upper bound to
	// avoid wrapping or overflow before conversion.
	var expiresAt pgtype.Timestamptz
	if req.ExpiresIn != nil {
		if *req.ExpiresIn <= 0 || int64(*req.ExpiresIn) > expiresInMaxHours {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("expires_in must be between 1 and %d hours", expiresInMaxHours))
			return
		}
		expiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Duration(*req.ExpiresIn) * time.Hour), Valid: true}
	}

	var maxUses pgtype.Int4
	if req.MaxUses != nil {
		if *req.MaxUses <= 0 || *req.MaxUses > math.MaxInt32 {
			writeError(w, http.StatusBadRequest, "max_uses must be between 1 and 2147483647")
			return
		}
		maxUses = pgtype.Int4{Int32: int32(*req.MaxUses), Valid: true}
	}

	// Rotating to a new link and deactivating the previous one must be atomic:
	// deactivating outside the transaction (as before) could destroy the old
	// working link if the insert fails, and ignoring deactivation errors could
	// leave multiple active links. The partial unique index on
	// (workspace_id) WHERE is_active also fails closed on concurrent creates.
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create share link")
		return
	}
	defer tx.Rollback(r.Context())

	qtx := h.Queries.WithTx(tx)

	if err := qtx.DeactivateWorkspaceShareLinks(r.Context(), requester.WorkspaceID); err != nil {
		slog.Warn("deactivate share links failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create share link")
		return
	}

	code, err := generateShareCode()
	if err != nil {
		slog.Warn("generate share code failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create share link")
		return
	}

	link, err := qtx.CreateShareLink(r.Context(), db.CreateShareLinkParams{
		WorkspaceID: requester.WorkspaceID,
		Code:        code,
		CreatedBy:   requester.UserID,
		Role:        role,
		ExpiresAt:   expiresAt,
		MaxUses:     maxUses,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a share link is already active for this workspace")
			return
		}
		slog.Warn("create share link failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create share link")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Warn("commit share link failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create share link")
		return
	}

	slog.Info("share link created", append(logger.RequestAttrs(r), "share_link_id", uuidToString(link.ID), "workspace_id", workspaceID)...)

	resp := shareLinkToResponse(link)
	writeJSON(w, http.StatusCreated, resp)
}

// ListShareLinks — list active share links for a workspace (admin view).
// GET /api/workspaces/{id}/share-links
func (h *Handler) ListShareLinks(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	rows, err := h.Queries.ListShareLinksByWorkspace(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list share links")
		return
	}

	resp := make([]ShareLinkResponse, len(rows))
	for i, row := range rows {
		resp[i] = shareLinkListToResponse(row)
	}
	if resp == nil {
		resp = []ShareLinkResponse{}
	}

	writeJSON(w, http.StatusOK, resp)
}

// RevokeShareLink — admin revokes a share link.
// DELETE /api/workspaces/{id}/share-links/{linkId}
func (h *Handler) RevokeShareLink(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	linkID := chi.URLParam(r, "linkId")
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	linkUUID, ok := parseUUIDOrBadRequest(w, linkID, "link id")
	if !ok {
		return
	}

	if err := h.Queries.RevokeShareLink(r.Context(), db.RevokeShareLinkParams{
		ID:          linkUUID,
		WorkspaceID: workspaceUUID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to revoke share link")
		return
	}

	slog.Info("share link revoked", "share_link_id", linkID, "workspace_id", workspaceID)
	w.WriteHeader(http.StatusNoContent)
}

// ShareLinkInfoResponse is the public, pre-join preview of a share link:
// only what a visitor needs to decide whether to join — the workspace name,
// its slug, the inviting user's display name, and the role the link grants.
// It deliberately excludes internal IDs (workspace_id), the invite code, and
// the inviter's email address.
type ShareLinkInfoResponse struct {
	WorkspaceName string `json:"workspace_name"`
	WorkspaceSlug string `json:"workspace_slug"`
	CreatorName   string `json:"creator_name,omitempty"`
	Role          string `json:"role"`
}

// GetShareLinkInfo — public preview of a workspace share link. No auth is
// required so a not-yet-logged-in visitor can see what they're joining before
// signing in. Only the workspace name/slug and inviter are exposed.
// GET /api/share-links/{code}
func (h *Handler) GetShareLinkInfo(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	code = strings.TrimSpace(code)
	if code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	row, err := h.Queries.GetShareLinkInfoByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "share link not found or expired")
		return
	}

	writeJSON(w, http.StatusOK, ShareLinkInfoResponse{
		WorkspaceName: row.WorkspaceName,
		WorkspaceSlug: row.WorkspaceSlug,
		CreatorName:   row.CreatorName,
		Role:          row.Role,
	})
}

// JoinByShareLink — authenticated user joins a workspace via a share link.
// POST /api/share-links/join
func (h *Handler) JoinByShareLink(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req JoinByShareLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	code := strings.TrimSpace(req.Code)
	if code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	user, err := h.Queries.GetUser(r.Context(), parseUUID(userID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load user")
		return
	}

	linkPreview, err := h.Queries.GetActiveShareLinkByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "share link not found or expired")
		return
	}
	if _, memberErr := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID: user.ID, WorkspaceID: linkPreview.WorkspaceID,
	}); memberErr == nil {
		writeError(w, http.StatusConflict, "you are already a member of this workspace")
		return
	} else if !errors.Is(memberErr, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to join workspace")
		return
	}

	var capacityToken uuid.UUID
	if h.seatCapacityEnabled() {
		capacityToken, err = h.beginShareJoinCapacity(r.Context(), uuid.UUID(linkPreview.WorkspaceID.Bytes), uuid.UUID(linkPreview.ID.Bytes), uuid.UUID(user.ID.Bytes))
		if err != nil {
			writeSeatCapacityError(w, err)
			return
		}
	}

	// 分享链接的 workspace_id 和 role 创建后不再变化，预览行与事务内认领到的行取值一致。
	member, err := h.admitWorkspaceMember(r.Context(), admitMemberInput{
		WorkspaceID:    linkPreview.WorkspaceID,
		User:           user,
		Role:           linkPreview.Role,
		CapacityToken:  capacityToken,
		CapacityAction: seatcapacity.ActionClaimShareJoin,
		Claim:          claimShareLink(linkPreview.ID),
		Source:         admitSourceShareLink,
	})
	if err != nil {
		writeShareJoinAdmitError(w, r, err)
		return
	}

	ws, err := h.Queries.GetWorkspace(r.Context(), linkPreview.WorkspaceID)
	wsSlug := ""
	if err == nil {
		wsSlug = ws.Slug
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"member":         h.memberWithUserResponse(member, user),
		"workspace_id":   uuidToString(linkPreview.WorkspaceID),
		"workspace_slug": wsSlug,
	})
}

// claimShareLink 返回分享链接加入用的 Claim：在事务里用带条件的原子更新复核链接有效、
// 未过期、未用完，并占用一次名额；不满足时返回 errAdmitClaimRejected。
func claimShareLink(linkID pgtype.UUID) func(ctx context.Context, qtx *db.Queries) error {
	return func(ctx context.Context, qtx *db.Queries) error {
		_, err := qtx.ClaimShareLinkByID(ctx, linkID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errAdmitClaimRejected
		}
		if err != nil {
			return errors.Wrapf(err, "claim share link share_link_id=%s", uuidToString(linkID))
		}

		return nil
	}
}

// writeShareJoinAdmitError 把成员写入失败映射回分享链接加入接口原有的状态码和文案。
func writeShareJoinAdmitError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errAdmitAlreadyMember) {
		writeError(w, http.StatusConflict, "you are already a member of this workspace")
		return
	}

	// 名额被拒是预期结果，其余都是意外错误，在这里记录一次。
	if !errors.Is(err, errAdmitClaimRejected) {
		slog.Warn("join share link failed", append(logger.RequestAttrs(r), "error", err)...)
	}

	switch admitFailedStep(err) {
	case admitStepClaim:
		// 认领失败一律按链接失效处理，errAdmitClaimRejected 也带这个步骤标记。
		writeError(w, http.StatusNotFound, "share link not found or expired")
	case admitStepCreateMember:
		writeError(w, http.StatusInternalServerError, "failed to create membership")
	case admitStepMarkOnboarded:
		writeError(w, http.StatusInternalServerError, "failed to finalize onboarding")
	default:
		writeError(w, http.StatusInternalServerError, "failed to join workspace")
	}
}

func shareLinkToResponse(link db.WorkspaceShareLink) ShareLinkResponse {
	var expiresAt *string
	if link.ExpiresAt.Valid {
		s := timestampToString(link.ExpiresAt)
		expiresAt = &s
	}
	var maxUses *int32
	if link.MaxUses.Valid {
		maxUses = &link.MaxUses.Int32
	}
	return ShareLinkResponse{
		ID:          uuidToString(link.ID),
		WorkspaceID: uuidToString(link.WorkspaceID),
		Code:        link.Code,
		CreatedBy:   uuidToString(link.CreatedBy),
		Role:        link.Role,
		ExpiresAt:   expiresAt,
		MaxUses:     maxUses,
		UseCount:    link.UseCount,
		IsActive:    link.IsActive,
		CreatedAt:   timestampToString(link.CreatedAt),
	}
}

func shareLinkListToResponse(row db.ListShareLinksByWorkspaceRow) ShareLinkResponse {
	var expiresAt *string
	if row.ExpiresAt.Valid {
		s := timestampToString(row.ExpiresAt)
		expiresAt = &s
	}
	var maxUses *int32
	if row.MaxUses.Valid {
		maxUses = &row.MaxUses.Int32
	}
	return ShareLinkResponse{
		ID:           uuidToString(row.ID),
		WorkspaceID:  uuidToString(row.WorkspaceID),
		Code:         row.Code,
		CreatedBy:    uuidToString(row.CreatedBy),
		Role:         row.Role,
		ExpiresAt:    expiresAt,
		MaxUses:      maxUses,
		UseCount:     row.UseCount,
		IsActive:     row.IsActive,
		CreatedAt:    timestampToString(row.CreatedAt),
		CreatorName:  row.CreatorName,
		CreatorEmail: row.CreatorEmail,
	}
}
