package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// 写入者类型（author_type、created_by_type、事件 actor_type 的取值）。
const (
	actorTypeMember = "member"
	actorTypeAgent  = "agent"
)

// 平台内置 autopilot 的 system_key 与暂停原因。
const (
	// autopilotSystemKeyKnowledgeDigest 标记每日知识沉淀：每个工作区一个，不能删除，没有知识库时不能启用。
	autopilotSystemKeyKnowledgeDigest = "knowledge-digest"
	// pauseReasonNoKnowledgeBase 是删光知识库后每日知识沉淀被自动停用的原因。
	pauseReasonNoKnowledgeBase = "no_knowledge_base"
)

const (
	knowledgeDigestTitle       = "Daily knowledge digest"
	knowledgeDigestDefaultCron = "0 22 * * *"
	knowledgeDigestDefaultTZ   = "UTC"
)

// knowledgeDigestInstructions 是每日知识沉淀的默认执行说明，写进 autopilot 描述，owner / admin 可以改。
const knowledgeDigestInstructions = `Distill what the workspace learned since the last digest into its knowledge bases.

1. Run "marvis kb sources --output json" and read every page it reports ("--page 2", ...). Pass the
   "since" and "until" of the first page to later pages unchanged. If "truncated" is true, say so in the summary.
2. Run "marvis kb list" and read each knowledge base's purpose.md and AGENTS.md. Keep only durable knowledge
   that fits a knowledge base's purpose: decisions, rules, how-tos, known issues, facts about systems.
   Skip chatter, status updates and anything already recorded (check with "marvis kb search").
3. Clone once ("marvis kb clone <dir>"), edit pages in every knowledge base that needs it, update index.md,
   log.md and the claims, cite each fact with its source URI. Chat sources are private: cite, never quote.
4. Run "marvis kb lint --dir <dir>" and fix the errors. Remove secrets, tokens, passwords, phone numbers and ID numbers.
5. Open ONE change request for all knowledge bases: "marvis kb change create --dir <dir> --source digest
   --title 'Daily digest <date>' --summary <self-review> --risk <low|medium|high>".
   If nothing is worth recording, do not open a change request and say why in your final message.`

// KnowledgeDigestResponse 是每日知识沉淀的配置；未创建时 autopilot 为 null。
type KnowledgeDigestResponse struct {
	Autopilot          *AutopilotResponse        `json:"autopilot"`
	Schedule           *AutopilotTriggerResponse `json:"schedule"`
	KnowledgeBaseCount int                       `json:"knowledge_base_count"`
}

// GetKnowledgeDigest 返回每日知识沉淀的配置（GET /api/knowledge/digest）。
func (h *Handler) GetKnowledgeDigest(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}

	resp, err := h.knowledgeDigest(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load knowledge digest")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) knowledgeDigest(ctx context.Context, workspaceID string) (KnowledgeDigestResponse, error) {
	ws := parseUUID(workspaceID)
	count, err := h.Queries.CountKnowledgeBases(ctx, ws)
	if err != nil {
		return KnowledgeDigestResponse{}, errors.Wrapf(err, "count knowledge bases workspace_id=%s", workspaceID)
	}
	resp := KnowledgeDigestResponse{KnowledgeBaseCount: int(count)}

	ap, err := h.Queries.GetAutopilotBySystemKey(ctx, db.GetAutopilotBySystemKeyParams{
		WorkspaceID: ws, SystemKey: pgtype.Text{String: autopilotSystemKeyKnowledgeDigest, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return resp, nil
	}
	if err != nil {
		return resp, errors.Wrapf(err, "get knowledge digest workspace_id=%s", workspaceID)
	}
	apResp := autopilotToResponse(ap, nil)
	resp.Autopilot = &apResp

	triggers, err := h.Queries.ListAutopilotTriggers(ctx, ap.ID)
	if err != nil {
		return resp, errors.Wrapf(err, "list digest triggers autopilot_id=%s", uuidToString(ap.ID))
	}
	for _, t := range triggers {
		if t.Kind == autopilotTriggerSchedule {
			tr := h.triggerToResponse(t)
			resp.Schedule = &tr
			break
		}
	}

	return resp, nil
}

// CreateKnowledgeDigestRequest 是首次配置每日知识沉淀的请求。
type CreateKnowledgeDigestRequest struct {
	AssigneeID     string `json:"assignee_id"`
	CronExpression string `json:"cron_expression"`
	Timezone       string `json:"timezone"`
}

// CreateKnowledgeDigest 首次配置每日知识沉淀（POST /api/knowledge/digest），仅 owner / admin。
// autopilot 的执行者不能为空，所以它在第一次配置时才创建，创建后处于停用状态；
// 之后的编辑、启用、停用、立即运行都走 autopilot 接口。
func (h *Handler) CreateKnowledgeDigest(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return
	}
	var req CreateKnowledgeDigestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	assigneeID, ok := parseUUIDOrBadRequest(w, req.AssigneeID, "assignee_id")
	if !ok {
		return
	}
	cronExpr := strings.TrimSpace(req.CronExpression)
	if cronExpr == "" {
		cronExpr = knowledgeDigestDefaultCron
	}
	tz := strings.TrimSpace(req.Timezone)
	if tz == "" {
		tz = knowledgeDigestDefaultTZ
	}
	nextRun, err := computeNextRun(cronExpr, tz)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cron_expression or timezone")
		return
	}

	ctx := r.Context()
	ws := parseUUID(workspaceID)
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge digest")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	if !h.validateAutopilotAssigneeForSave(w, r, qtx, autopilotAssigneeAgent, assigneeID, ws, false) {
		return
	}
	ap, err := h.createKnowledgeDigestRows(ctx, qtx, ws, member.UserID, assigneeID, cronExpr, tz, nextRun)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "knowledge digest already exists")
			return
		}
		writeKnowledgeError(w, r, err, "failed to create knowledge digest")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge digest")
		return
	}

	resp, err := h.knowledgeDigest(ctx, workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to load knowledge digest")
		return
	}
	h.publish(protocol.EventAutopilotCreated, workspaceID, actorTypeMember, uuidToString(member.UserID), map[string]any{"autopilot": autopilotToResponse(ap, nil)})
	writeJSON(w, http.StatusCreated, resp)
}

// createKnowledgeDigestRows 在事务里建 autopilot（停用、run_only、带 system_key）和它的定时触发器，并记录规则版本。
func (h *Handler) createKnowledgeDigestRows(
	ctx context.Context, qtx *db.Queries, ws, actorID, assigneeID pgtype.UUID, cronExpr, tz string, nextRun time.Time,
) (db.Autopilot, error) {
	ap, err := qtx.CreateAutopilot(ctx, db.CreateAutopilotParams{
		WorkspaceID: ws, Title: knowledgeDigestTitle, AssigneeType: autopilotAssigneeAgent, AssigneeID: assigneeID,
		Status: autopilotStatusPaused, ExecutionMode: autopilotModeRunOnly, CreatedByType: actorTypeMember, CreatedByID: actorID,
		Description: pgtype.Text{String: knowledgeDigestInstructions, Valid: true},
	})
	if err != nil {
		return db.Autopilot{}, errors.Wrapf(err, "create digest autopilot workspace_id=%s", uuidToString(ws))
	}
	key := pgtype.Text{String: autopilotSystemKeyKnowledgeDigest, Valid: true}
	if err := qtx.SetAutopilotSystemKey(ctx, db.SetAutopilotSystemKeyParams{ID: ap.ID, WorkspaceID: ap.WorkspaceID, SystemKey: key}); err != nil {
		return db.Autopilot{}, errors.Wrapf(err, "set digest system key autopilot_id=%s", uuidToString(ap.ID))
	}
	ap.SystemKey = key

	if _, err := qtx.CreateAutopilotTrigger(ctx, db.CreateAutopilotTriggerParams{
		AutopilotID: ap.ID, Kind: autopilotTriggerSchedule, Enabled: true,
		CronExpression: pgtype.Text{String: cronExpr, Valid: true}, Timezone: pgtype.Text{String: tz, Valid: true},
		NextRunAt:       pgtype.Timestamptz{Time: nextRun, Valid: true},
		PublishedByType: pgtype.Text{String: actorTypeMember, Valid: true}, PublishedByID: actorID,
		CreatedByType: pgtype.Text{String: actorTypeMember, Valid: true}, CreatedByID: actorID,
	}); err != nil {
		return db.Autopilot{}, errors.Wrapf(err, "create digest trigger autopilot_id=%s", uuidToString(ap.ID))
	}
	if err := h.recordAutopilotRuleVersion(ctx, qtx, ap, actorTypeMember, actorID); err != nil {
		return db.Autopilot{}, errors.Wrapf(err, "record digest rule version autopilot_id=%s", uuidToString(ap.ID))
	}

	return ap, nil
}

// afterKnowledgeBaseRemoved 在知识库删除后执行：删光时停用每日知识沉淀。
func (h *Handler) afterKnowledgeBaseRemoved(ctx context.Context, qtx *db.Queries, workspaceID pgtype.UUID) error {
	count, err := qtx.CountKnowledgeBases(ctx, workspaceID)
	if err != nil {
		return errors.Wrapf(err, "count knowledge bases workspace_id=%s", uuidToString(workspaceID))
	}
	if count > 0 {
		return nil
	}

	err = qtx.PauseSystemAutopilot(ctx, db.PauseSystemAutopilotParams{
		WorkspaceID: workspaceID, SystemKey: pgtype.Text{String: autopilotSystemKeyKnowledgeDigest, Valid: true},
		PauseReason: pgtype.Text{String: pauseReasonNoKnowledgeBase, Valid: true},
	})

	return errors.Wrapf(err, "pause knowledge digest workspace_id=%s", uuidToString(workspaceID))
}

// lastKnowledgeDigestRun 返回每日知识沉淀上一次成功运行的开始时间；没有记录时返回零值。
func (h *Handler) lastKnowledgeDigestRun(ctx context.Context, workspaceID string) (time.Time, error) {
	ap, err := h.Queries.GetAutopilotBySystemKey(ctx, db.GetAutopilotBySystemKeyParams{
		WorkspaceID: parseUUID(workspaceID), SystemKey: pgtype.Text{String: autopilotSystemKeyKnowledgeDigest, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, errors.Wrapf(err, "get knowledge digest workspace_id=%s", workspaceID)
	}

	at, err := h.Queries.GetLastCompletedAutopilotRunAt(ctx, ap.ID)
	if err != nil {
		return time.Time{}, errors.Wrapf(err, "last digest run autopilot_id=%s", uuidToString(ap.ID))
	}
	if !at.Valid || at.Time.Unix() <= 0 {
		return time.Time{}, nil
	}

	return at.Time, nil
}

// systemAutopilotGuard 检查对内置 autopilot 的写操作：不能归档（删除），不能改执行方式，
// 每日知识沉淀在没有知识库时不能启用。返回非空字符串时调用方以 409 拒绝。
func (h *Handler) systemAutopilotGuard(ctx context.Context, ap db.Autopilot, status, executionMode *string) (string, error) {
	if !ap.SystemKey.Valid {
		return "", nil
	}
	if status != nil && *status == autopilotStatusArchived {
		return errMsgBuiltinAutopilotDelete, nil
	}
	if executionMode != nil && *executionMode != ap.ExecutionMode {
		return "the execution mode of a built-in autopilot cannot be changed", nil
	}
	if status != nil && *status == autopilotStatusActive && ap.SystemKey.String == autopilotSystemKeyKnowledgeDigest {
		count, err := h.Queries.CountKnowledgeBases(ctx, ap.WorkspaceID)
		if err != nil {
			return "", errors.Wrapf(err, "count knowledge bases workspace_id=%s", uuidToString(ap.WorkspaceID))
		}
		if count == 0 {
			return "create a knowledge base before enabling the daily knowledge digest", nil
		}
	}

	return "", nil
}
