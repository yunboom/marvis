package handler

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// taskKnowledgeBaseCap bounds the knowledge bases a task claim lists (spec
// 8.2); the brief points at `marvis kb list` for the rest.
const taskKnowledgeBaseCap = 30

// TaskKnowledgeBaseData is one knowledge base on the task claim wire: a row
// of the brief's Knowledge Bases section.
type TaskKnowledgeBaseData struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// taskKnowledgeBases lists a workspace's knowledge bases for a task claim, by
// name, and whether more exist than the cap lets through.
func (h *Handler) taskKnowledgeBases(ctx context.Context, workspaceID pgtype.UUID) ([]TaskKnowledgeBaseData, bool, error) {
	rows, err := h.Queries.ListKbBaseBriefs(ctx, db.ListKbBaseBriefsParams{
		WorkspaceID: workspaceID,
		Limit:       taskKnowledgeBaseCap + 1,
	})
	if err != nil {
		return nil, false, errors.Wrapf(err, "list knowledge bases for task claim workspace_id=%s", uuidToString(workspaceID))
	}

	truncated := len(rows) > taskKnowledgeBaseCap
	if truncated {
		rows = rows[:taskKnowledgeBaseCap]
	}

	bases := make([]TaskKnowledgeBaseData, len(rows))
	for i, row := range rows {
		bases[i] = TaskKnowledgeBaseData{Slug: row.Slug, Name: row.Name, Description: row.Description}
	}

	return bases, truncated, nil
}
