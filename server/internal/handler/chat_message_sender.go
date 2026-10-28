package handler

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// chatMessageRoleUser is the chat_message role of a message a member sent.
const chatMessageRoleUser = "user"

// chatMessageSenders maps each user message to the member who sent it, read
// from the initiator of the turn the message started. One query per page.
func (h *Handler) chatMessageSenders(ctx context.Context, messages []db.ChatMessage) (map[string]*string, error) {
	taskIDs := make([]pgtype.UUID, 0, len(messages))
	for _, m := range messages {
		if m.Role == chatMessageRoleUser && m.TaskID.Valid {
			taskIDs = append(taskIDs, m.TaskID)
		}
	}
	if len(taskIDs) == 0 {
		return map[string]*string{}, nil
	}

	rows, err := h.Queries.ListChatMessageSenders(ctx, taskIDs)
	if err != nil {
		return nil, errors.Wrap(err, "list chat message senders")
	}
	senderByTask := make(map[string]string, len(rows))
	for _, row := range rows {
		senderByTask[uuidToString(row.TaskID)] = uuidToString(row.InitiatorUserID)
	}

	senders := make(map[string]*string, len(taskIDs))
	for _, m := range messages {
		if sender, ok := senderByTask[uuidToString(m.TaskID)]; ok && m.Role == chatMessageRoleUser {
			senders[uuidToString(m.ID)] = &sender
		}
	}

	return senders, nil
}
