package handler

import (
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// kbConflictKinds maps each conflict of a 409 body to its kind, by page id.
func kbConflictKinds(got map[string]any) map[string]string {
	kinds := map[string]string{}
	list, _ := got["conflicts"].([]any)
	for _, item := range list {
		c, _ := item.(map[string]any)
		pageID, _ := c["page_id"].(string)
		kind, _ := c["kind"].(string)
		kinds[pageID] = kind
	}

	return kinds
}

// TestKbMergeKeepsTreeWhole refuses merges and reverts that would leave a
// live page under a deleted parent: deleting a page that gained a child on
// the mainline, creating a page under a parent the mainline deleted, and
// reverting the creation of a page that has a child by now.
func TestKbMergeKeepsTreeWhole(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	header := map[string]any{"type": "Guide", "title": "Child", "description": "d"}

	// B is deleted in one draft while another gives it a child.
	deleteB := createKbDraftAs(t, f.slug, nil)
	kbOps(t, deleteB, f.pageB, kbPageHead(t, f.pageB), http.StatusOK, map[string]any{"op": kb.OpDelete})
	deleteBMR := openKbMR(t, deleteB)
	childDraft := createKbDraftAs(t, f.slug, nil)
	kbDraftCreatePage(t, childDraft, map[string]any{"parent": f.slug + ":/b", "slug": "child", "frontmatter": header, "content": "# Child\n\nSee [b](/b.md)."})
	childMR := openKbMR(t, childDraft)
	mergeKbMR(t, childMR.Number, childMR.DraftVersion, nil, http.StatusOK)

	got := mergeKbMR(t, deleteBMR.Number, deleteBMR.DraftVersion, nil, http.StatusConflict)
	if got["code"] != kbCodeMergeConflict || kbConflictKinds(got)[f.pageB] != kb.ConflictPage {
		t.Fatalf("deleting a page that gained a child = %v", got)
	}

	// A page created under Callback after Callback was deleted on the mainline.
	underA := createKbDraftAs(t, f.slug, nil)
	created := kbDraftCreatePage(t, underA, map[string]any{"parent": f.slug + ":/callback", "slug": "late", "frontmatter": header, "content": "# Late\n\nSee [b](/b.md)."})
	latePage, _ := created["page_id"].(string)
	underAMR := openKbMR(t, underA)
	deleteA := createKbDraftAs(t, f.slug, nil)
	kbOps(t, deleteA, f.pageA, kbPageHead(t, f.pageA), http.StatusOK, map[string]any{"op": kb.OpDelete})
	deleteAMR := openKbMR(t, deleteA)
	mergeKbMR(t, deleteAMR.Number, deleteAMR.DraftVersion, nil, http.StatusOK)

	got = mergeKbMR(t, underAMR.Number, underAMR.DraftVersion, nil, http.StatusConflict)
	if got["code"] != kbCodeMergeConflict || kbConflictKinds(got)[latePage] != kb.ConflictMove {
		t.Fatalf("creating a page under a deleted parent = %v", got)
	}

	// Reverting the creation of a page that has a child by now.
	guideDraft := createKbDraftAs(t, f.slug, nil)
	guide := kbDraftCreatePage(t, guideDraft, map[string]any{"parent": f.slug + ":/", "slug": "guide", "frontmatter": header, "content": "# Guide\n\nSee [b](/b.md)."})
	guidePage, _ := guide["page_id"].(string)
	guideMR := openKbMR(t, guideDraft)
	mergeKbMR(t, guideMR.Number, guideMR.DraftVersion, nil, http.StatusOK)
	stepDraft := createKbDraftAs(t, f.slug, nil)
	kbDraftCreatePage(t, stepDraft, map[string]any{"parent": f.slug + ":/guide", "slug": "step", "frontmatter": header, "content": "# Step\n\nSee [b](/b.md)."})
	stepMR := openKbMR(t, stepDraft)
	mergeKbMR(t, stepMR.Number, stepMR.DraftVersion, nil, http.StatusOK)

	got = testutil.Call(t, testHandler.RevertKbMergeRequest, kbMRRequest(http.MethodPost, guideMR.Number, nil, nil)).Want(http.StatusConflict).Map()
	if got["code"] != kbCodeRevertConflict || kbConflictKinds(got)[guidePage] != kb.ConflictPage {
		t.Errorf("reverting a page that has a child = %v", got)
	}
}
