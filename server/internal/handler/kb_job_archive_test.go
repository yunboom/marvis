package handler

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

func setKbJobArchived(t *testing.T, jobID string, body any, mutate func(*http.Request), want int) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodPatch, "/api/kb/jobs/x/archive", body), "jobId", jobID)
	if mutate != nil {
		mutate(req)
	}

	return testutil.Call(t, testHandler.SetKbJobArchived, req).Want(want).Map()
}

func deleteKbJob(t *testing.T, jobID string, mutate func(*http.Request), want int) {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodDelete, "/api/kb/jobs/x", nil), "jobId", jobID)
	if mutate != nil {
		mutate(req)
	}
	testutil.Call(t, testHandler.DeleteKbJob, req).Want(want)
}

func listKbJobsAs(t *testing.T, userID, slug, query string) []KbJobResponse {
	t.Helper()

	req := testutil.WithURLParams(newRequestAs(userID, http.MethodGet, "/api/kb/bases/x/jobs"+query, nil), "kb", slug)
	var got []KbJobResponse
	testutil.Call(t, testHandler.ListKbJobs, req).Want(http.StatusOK).JSON(&got)

	return got
}

// TestKbJobArchive archives a job through its chat's status and back: the
// list flags it and leaves it out of the state filters, the running turn is
// left alone, and only the job's creator may do it.
func TestKbJobArchive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	created := createKbJob(t, f.slug, map[string]any{"agent_id": f.agentID, "starter": kb.StarterCustom, "message": "m"}, http.StatusCreated)
	jobID, _ := created["id"].(string)
	sessionID, _ := created["chat_session_id"].(string)
	if created["archived"] != false {
		t.Fatalf("new job archived = %v", created["archived"])
	}

	other := createPlainMember(t, fmt.Sprintf("kb-job-archive-other-%d@marvis.ai", time.Now().UnixNano()))
	setKbJobArchived(t, jobID, map[string]any{"archived": true}, asMember(other), http.StatusForbidden)
	setKbJobArchived(t, jobID, "not an object", nil, http.StatusBadRequest)

	archived := setKbJobArchived(t, jobID, map[string]any{"archived": true}, nil, http.StatusOK)
	if archived["archived"] != true {
		t.Errorf("archive response = %v", archived)
	}
	var status string
	dbfx.QueryRow(t, `SELECT status FROM chat_session WHERE id = $1`, sessionID).Scan(&status)
	if status != kbChatSessionArchived {
		t.Errorf("job chat status = %q", status)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id = $1 AND status = 'cancelled'`, sessionID); n != 0 {
		t.Errorf("archive cancelled %d tasks", n)
	}

	all := listKbJobsAs(t, testUserID, f.slug, "")
	if len(all) != 1 || !all[0].Archived {
		t.Errorf("list after archive = %+v", all)
	}
	if running := listKbJobsAs(t, testUserID, f.slug, "?state=running"); len(running) != 0 {
		t.Errorf("archived job in the running filter: %+v", running)
	}
	if detail := getKbJob(t, jobID, nil, http.StatusOK); !detail.Archived {
		t.Error("job detail not archived")
	}

	restored := setKbJobArchived(t, jobID, map[string]any{"archived": false}, nil, http.StatusOK)
	if restored["archived"] != false {
		t.Errorf("unarchive response = %v", restored)
	}
	if running := listKbJobsAs(t, testUserID, f.slug, "?state=running"); len(running) != 1 {
		t.Errorf("running filter after unarchive = %d", len(running))
	}
}

// TestKbJobDelete hard-deletes jobs: the chat goes with its running task
// cancelled, an unsubmitted draft is discarded, and a submitted draft keeps
// its merge request, which loses only its link to the job.
func TestKbJobDelete(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	newJob := func() (string, string) {
		created := createKbJob(t, f.slug, map[string]any{"agent_id": f.agentID, "starter": kb.StarterNewPage, "message": "m"}, http.StatusCreated)
		jobID, _ := created["id"].(string)
		sessionID, _ := created["chat_session_id"].(string)

		return jobID, sessionID
	}
	linkDraft := func(jobID string) string {
		return createKbJobDraft(t, f, jobID)
	}

	// A running job with an open draft.
	runningJob, runningSession := newJob()
	openDraft := linkDraft(runningJob)
	var taskID string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE chat_session_id = $1`, runningSession).Scan(&taskID)

	other := createPlainMember(t, fmt.Sprintf("kb-job-delete-other-%d@marvis.ai", time.Now().UnixNano()))
	deleteKbJob(t, runningJob, asMember(other), http.StatusForbidden)

	deleteKbJob(t, runningJob, nil, http.StatusNoContent)
	getKbJob(t, runningJob, nil, http.StatusNotFound)
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE id = $1`, runningSession); n != 0 {
		t.Error("job chat survived the delete")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_job_draft WHERE job_id = $1`, runningJob); n != 0 {
		t.Error("draft link survived the delete")
	}
	var taskStatus, draftStatus string
	dbfx.QueryRow(t, `SELECT status FROM agent_task_queue WHERE id = $1`, taskID).Scan(&taskStatus)
	if taskStatus != kbTaskCancelled {
		t.Errorf("running task status after delete = %q", taskStatus)
	}
	dbfx.QueryRow(t, `SELECT status FROM kb_draft WHERE id = $1`, openDraft).Scan(&draftStatus)
	if draftStatus != kb.DraftStatusDiscarded {
		t.Errorf("open draft status after delete = %q", draftStatus)
	}
	deleteKbJob(t, runningJob, nil, http.StatusNotFound)

	// A job whose draft is under review, archived first as the UI requires.
	reviewJob, reviewSession := newJob()
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE chat_session_id = $1`, reviewSession)
	reviewDraft := linkDraft(reviewJob)
	kbOps(t, reviewDraft, f.pageID, kbPageHead(t, f.pageID), http.StatusOK, map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"description": "new"}})
	submitted := postKbJobAction(t, testHandler.SubmitKbJob, reviewJob, nil, http.StatusCreated)
	number := int(submitted["number"].(float64))
	if before := getKbMR(t, number, nil); before.Origin.Type != kbOriginJob {
		t.Fatalf("origin before delete = %+v", before.Origin)
	}
	setKbJobArchived(t, reviewJob, map[string]any{"archived": true}, nil, http.StatusOK)

	deleteKbJob(t, reviewJob, nil, http.StatusNoContent)
	after := getKbMR(t, number, nil)
	if after.Status != kb.MergeRequestStatusOpen || after.JobID != nil || after.Origin.Type != kbOriginNone {
		t.Errorf("merge request after its job was deleted = status %q job_id %v origin %+v", after.Status, after.JobID, after.Origin)
	}
	dbfx.QueryRow(t, `SELECT status FROM kb_draft WHERE id = $1`, reviewDraft).Scan(&draftStatus)
	if draftStatus != kb.DraftStatusSubmitted {
		t.Errorf("submitted draft status after delete = %q", draftStatus)
	}
	if len(after.Pages) == 0 {
		t.Error("merge request lost its changes")
	}
}
