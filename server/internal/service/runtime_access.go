package service

import (
	"slices"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// RuntimeAllowsUser evaluates machine-owner consent after workspace membership
// has been checked by the caller. Sharing never grants machine administration.
func RuntimeAllowsUser(rt db.AgentRuntime, userID pgtype.UUID) bool {
	return rt.OwnerID.Valid && userID.Valid && (rt.OwnerID == userID ||
		rt.Visibility == "public" || (rt.Visibility == "private" && slices.Contains(rt.SharedWith, userID)))
}
