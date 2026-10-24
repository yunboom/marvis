package handler

import (
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/testutil"
)

func TestCreateProjectIcon(t *testing.T) {
	for _, tc := range []struct {
		name   string
		icon   any
		status int
		want   *string
	}{
		{name: "glyph key", icon: "git-branch", status: http.StatusCreated, want: strPtr("git-branch")},
		{name: "empty clears", icon: "", status: http.StatusCreated},
		{name: "emoji rejected", icon: "🚀", status: http.StatusBadRequest},
		{name: "unknown key rejected", icon: "unicorn", status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := newRequest("POST", "/api/projects", map[string]any{"title": "icon " + tc.name, "icon": tc.icon})
			call := testutil.Call(t, testHandler.CreateProject, req).Want(tc.status)
			if tc.status != http.StatusCreated {
				return
			}

			var got ProjectResponse
			call.JSON(&got)
			if (got.Icon == nil) != (tc.want == nil) || derefStr(got.Icon) != derefStr(tc.want) {
				t.Fatalf("icon = %v, want %v", got.Icon, tc.want)
			}
		})
	}
}

func TestUpdateProjectIcon(t *testing.T) {
	projectID := dbfx.Project(t, "icon update", testutil.Cols{"icon": "rocket"})
	update := func(icon any, status int) ProjectResponse {
		t.Helper()
		var got ProjectResponse
		call := testutil.Call(t, testHandler.UpdateProject, withURLParam(newRequest("PUT", "/api/projects/"+projectID, map[string]any{"icon": icon}), "id", projectID)).Want(status)
		if status == http.StatusOK {
			call.JSON(&got)
		}
		return got
	}

	update("🎯", http.StatusBadRequest)

	if got := update("leaf", http.StatusOK); derefStr(got.Icon) != "leaf" {
		t.Fatalf("icon = %q, want leaf", derefStr(got.Icon))
	}

	if got := update("", http.StatusOK); got.Icon != nil {
		t.Fatalf("icon = %q, want cleared", *got.Icon)
	}
}

func TestProjectResponseHidesLegacyEmojiIcon(t *testing.T) {
	projectID := dbfx.Project(t, "legacy emoji icon", testutil.Cols{"icon": "📁"})

	var got ProjectResponse
	testutil.Call(t, testHandler.GetProject, withURLParam(newRequest("GET", "/api/projects/"+projectID, nil), "id", projectID)).Want(http.StatusOK).JSON(&got)

	if got.Icon != nil {
		t.Fatalf("icon = %q, want nil for a legacy emoji value", *got.Icon)
	}
}
