package kb

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// NewMergeRequest is a merge request about to be opened for a draft.
type NewMergeRequest struct {
	// Draft is the draft under review, locked by the caller's transaction.
	Draft         db.KbDraft
	JobID         pgtype.UUID
	Title         string
	Summary       string
	Source        string
	Risk          string
	AuthorType    string
	AuthorID      pgtype.UUID
	AnnotationIDs []pgtype.UUID
	// RevertsID is the merged request a revert undoes; invalid otherwise.
	RevertsID pgtype.UUID
}

// CreatedMergeRequest is an opened merge request and the annotations it took
// over (pending → processing).
type CreatedMergeRequest struct {
	MergeRequest db.KbMergeRequest
	Annotations  []pgtype.UUID
}

// CreateMergeRequest opens a merge request for a draft inside the caller's
// transaction: it numbers it within the workspace, marks the draft
// submitted and moves the named pending annotations to processing. The
// caller checks the draft beforehand (open, has changes, no error findings,
// no open merge request) and publishes the events after commit.
func CreateMergeRequest(ctx context.Context, q *db.Queries, in NewMergeRequest) (CreatedMergeRequest, error) {
	draftID := util.UUIDToString(in.Draft.ID)
	annotationIDs := in.AnnotationIDs
	if annotationIDs == nil {
		annotationIDs = []pgtype.UUID{}
	}

	number, err := q.NextKbMergeRequestNumber(ctx, in.Draft.WorkspaceID)
	if err != nil {
		return CreatedMergeRequest{}, errors.Wrapf(err, "allocate merge request number draft_id=%s", draftID)
	}

	mr, err := q.CreateKbMergeRequest(ctx, db.CreateKbMergeRequestParams{
		WorkspaceID:     in.Draft.WorkspaceID,
		Number:          number,
		KnowledgeBaseID: in.Draft.KnowledgeBaseID,
		Title:           in.Title,
		Summary:         in.Summary,
		Source:          in.Source,
		Risk:            in.Risk,
		AuthorType:      in.AuthorType,
		AuthorID:        in.AuthorID,
		DraftID:         in.Draft.ID,
		JobID:           in.JobID,
		AnnotationIds:   annotationIDs,
		RevertsID:       in.RevertsID,
	})
	if err != nil {
		return CreatedMergeRequest{}, errors.Wrapf(err, "create merge request draft_id=%s", draftID)
	}

	if _, err := q.SetKbDraftStatus(ctx, db.SetKbDraftStatusParams{ID: in.Draft.ID, Status: DraftStatusSubmitted}); err != nil {
		return CreatedMergeRequest{}, errors.Wrapf(err, "mark draft submitted draft_id=%s", draftID)
	}

	attached, err := AttachAnnotations(ctx, q, in.Draft.KnowledgeBaseID, mr.ID, annotationIDs)
	if err != nil {
		return CreatedMergeRequest{}, err
	}

	return CreatedMergeRequest{MergeRequest: mr, Annotations: attached}, nil
}
