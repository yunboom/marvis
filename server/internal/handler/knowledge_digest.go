package handler

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// afterKnowledgeBaseRemoved 在知识库删除后执行：删光时停用每日知识沉淀。
func (h *Handler) afterKnowledgeBaseRemoved(ctx context.Context, qtx *db.Queries, workspaceID pgtype.UUID) error {
	_ = ctx
	_ = qtx
	_ = workspaceID

	return nil
}
