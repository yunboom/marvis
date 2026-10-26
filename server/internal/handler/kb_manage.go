package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Actions of a kb.base.changed event.
const (
	kbBaseActionCreated = "created"
	kbBaseActionUpdated = "updated"
	kbBaseActionDeleted = "deleted"
)

// kbCodeConfirmMismatch is the delete confirmation not matching the name.
const kbCodeConfirmMismatch = "confirm_name_mismatch"

// DeleteKbBaseRequest confirms a knowledge base deletion by its name.
type DeleteKbBaseRequest struct {
	ConfirmName string `json:"confirm_name"`
}

// DeleteKbBaseResponse is the body of DELETE /api/kb/bases/{kb}.
type DeleteKbBaseResponse struct {
	Deleted bool `json:"deleted"`
	// ClosedMRs lists the open merge requests removed with the knowledge base.
	ClosedMRs []int32 `json:"closed_mrs"`
}

// publishKbBaseChanged tells clients a knowledge base was created, saved or
// deleted (spec 9).
func (h *Handler) publishKbBaseChanged(r *http.Request, base db.KbBase, action string) {
	workspaceID := uuidToString(base.WorkspaceID)
	actorType, actorID := h.resolveActor(r, requestUserID(r), workspaceID)
	h.publish(protocol.EventKbBaseChanged, workspaceID, actorType, actorID, map[string]any{
		"knowledge_base_id": uuidToString(base.ID),
		"slug":              base.Slug,
		"action":            action,
	})
}

// DeleteKbBase deletes a knowledge base and everything in it in one
// transaction (decision 102: its creator or an owner / admin, confirming by
// name). Raw file objects are removed from storage after the commit.
func (h *Handler) DeleteKbBase(w http.ResponseWriter, r *http.Request) {
	var req DeleteKbBaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, h.resolveWorkspaceID(r))
	if !ok {
		return
	}
	if !canConfigureKb(member, base) {
		writeError(w, http.StatusForbidden, "only the knowledge base creator or a workspace owner or admin can delete it")
		return
	}
	if req.ConfirmName != base.Name {
		h.writeKbError(w, r, kbFail(http.StatusBadRequest, kbCodeConfirmMismatch, "confirm_name does not match the knowledge base name"))
		return
	}

	closed, keys, err := h.deleteKnowledgeBase(r, base)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.deleteKbRawObjects(keys)
	h.publishKbBaseChanged(r, base, kbBaseActionDeleted)

	writeJSON(w, http.StatusOK, DeleteKbBaseResponse{Deleted: true, ClosedMRs: closed})
}

// deleteKnowledgeBase removes the rows of a knowledge base under its row
// lock and returns the open merge requests it had and the storage keys of
// its raw files.
func (h *Handler) deleteKnowledgeBase(r *http.Request, base db.KbBase) ([]int32, []string, error) {
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, errors.Wrap(err, "begin knowledge base delete")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.GetKbBaseForUpdate(ctx, db.GetKbBaseForUpdateParams{WorkspaceID: base.WorkspaceID, ID: base.ID}); err != nil {
		if isNotFound(err) {
			return nil, nil, kbFail(http.StatusNotFound, kbCodeKnowledgeBaseNF, "knowledge base not found")
		}
		return nil, nil, errors.Wrapf(err, "lock knowledge base knowledge_base_id=%s", uuidToString(base.ID))
	}

	closed, err := qtx.ListKbOpenMergeRequestNumbers(ctx, db.ListKbOpenMergeRequestNumbersParams{KnowledgeBaseID: base.ID, Status: kb.MergeRequestStatusOpen})
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list open merge requests knowledge_base_id=%s", uuidToString(base.ID))
	}
	keys, err := qtx.ListKbRawStorageKeys(ctx, base.ID)
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list raw storage keys knowledge_base_id=%s", uuidToString(base.ID))
	}

	hasEmbeddings, err := qtx.KbBlockEmbeddingTableExists(ctx)
	if err != nil {
		return nil, nil, errors.WithStack(err)
	}
	if hasEmbeddings {
		if err := qtx.DeleteKbBlockEmbeddingsByBase(ctx, base.ID); err != nil {
			return nil, nil, errors.Wrapf(err, "delete block embeddings knowledge_base_id=%s", uuidToString(base.ID))
		}
	}
	if err := qtx.DeleteKnowledgeBase(ctx, base.ID); err != nil {
		return nil, nil, errors.Wrapf(err, "delete knowledge base knowledge_base_id=%s", uuidToString(base.ID))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, errors.Wrap(err, "commit knowledge base delete")
	}
	if closed == nil {
		closed = []int32{}
	}

	return closed, keys, nil
}

// KbGraphNodeResponse is a page of the relationship graph.
type KbGraphNodeResponse struct {
	// Key is what edges reference: the page id, or the path of a missing page.
	Key     string  `json:"key"`
	ID      *string `json:"id"`
	Title   string  `json:"title"`
	Path    string  `json:"path"`
	Group   string  `json:"group"`
	Degree  int     `json:"degree"`
	Missing bool    `json:"missing"`
}

// KbGraphEdgeResponse is a link between two graph nodes, by node key.
type KbGraphEdgeResponse struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// KbGraphResponse is GET /api/kb/bases/{kb}/graph.
type KbGraphResponse struct {
	Nodes []KbGraphNodeResponse `json:"nodes"`
	Edges []KbGraphEdgeResponse `json:"edges"`
}

// GetKbGraph returns the relationship graph of a knowledge base: its live
// pages and the mainline links between them, plus pages linked but not yet
// written (spec 7.3).
func (h *Handler) GetKbGraph(w http.ResponseWriter, r *http.Request) {
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	treeRows, err := h.Queries.ListKbPageTree(r.Context(), base.ID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list page tree knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	linkRows, err := h.Queries.ListKbGraphLinks(r.Context(), base.ID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list graph links knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	nodes := make([]kb.TreeNode, len(treeRows))
	for i, row := range treeRows {
		nodes[i] = kb.TreeNode{ID: uuidToString(row.ID), ParentID: uuidToString(row.ParentID), Slug: row.Slug, Title: row.Title, Position: row.Position}
	}
	links := make([]kb.GraphLink, len(linkRows))
	for i, row := range linkRows {
		links[i] = kb.GraphLink{FromPageID: uuidToString(row.FromPageID), ToPageID: uuidToString(row.ToPageID), ToPath: row.ToPath}
	}
	graph := kb.BuildGraph(nodes, links)

	resp := KbGraphResponse{
		Nodes: make([]KbGraphNodeResponse, len(graph.Nodes)),
		Edges: make([]KbGraphEdgeResponse, len(graph.Edges)),
	}
	for i, node := range graph.Nodes {
		var id *string
		if !node.Missing {
			id = &graph.Nodes[i].ID
		}
		resp.Nodes[i] = KbGraphNodeResponse{Key: node.Key, ID: id, Title: node.Title, Path: node.Path, Group: node.Group, Degree: node.Degree, Missing: node.Missing}
	}
	for i, edge := range graph.Edges {
		resp.Edges[i] = KbGraphEdgeResponse{From: edge.From, To: edge.To}
	}

	writeJSON(w, http.StatusOK, resp)
}
