package handler

import (
	"testing"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// TestKbMergeRequestOriginOpenable opens a job or chat origin only for the
// member who started it; other origins open for every viewer.
func TestKbMergeRequestOriginOpenable(t *testing.T) {
	starter := parseUUID("01a17b44-0000-7000-8000-000000000001")
	other := "01a17b44-0000-7000-8000-000000000002"
	job := parseUUID("01a17b44-0000-7000-8000-000000000003")
	chat := parseUUID("01a17b44-0000-7000-8000-000000000004")
	issue := parseUUID("01a17b44-0000-7000-8000-000000000005")

	cases := []struct {
		name   string
		row    db.ListKbMergeRequestOriginsRow
		viewer string
		want   bool
	}{
		{name: "job by its starter", row: db.ListKbMergeRequestOriginsRow{JobID: job, JobCreatedBy: starter}, viewer: uuidToString(starter), want: true},
		{name: "job by someone else", row: db.ListKbMergeRequestOriginsRow{JobID: job, JobCreatedBy: starter}, viewer: other, want: false},
		{name: "chat by someone else", row: db.ListKbMergeRequestOriginsRow{TaskChatSessionID: chat, ChatCreatorID: starter}, viewer: other, want: false},
		{name: "issue by anyone", row: db.ListKbMergeRequestOriginsRow{TaskIssueID: issue}, viewer: other, want: true},
		{name: "none", row: db.ListKbMergeRequestOriginsRow{}, viewer: other, want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			origin := kbMergeRequestOrigin(db.KbMergeRequest{}, tc.row, nil)
			origin.restrictTo(tc.viewer)
			if origin.Openable != tc.want {
				t.Errorf("openable = %v, want %v (origin %+v)", origin.Openable, tc.want, origin)
			}
		})
	}
}
