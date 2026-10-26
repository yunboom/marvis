package kb

import "strings"

// TreeNode is the part of a live page that determines its path.
type TreeNode struct {
	ID       string
	ParentID string
	Slug     string
	// Title is only needed for breadcrumbs; path resolution ignores it.
	Title string
	// Position is the sibling sort key; only placing pages needs it.
	Position string
}

// PageTree resolves page paths (/parent/child) within one knowledge base. It
// implements PageResolver.
type PageTree struct {
	byID   map[string]TreeNode
	byPath map[string]string
	paths  map[string]string
}

// NewPageTree builds the path index from the live pages of a knowledge base.
// Pages whose parent chain is broken or cyclic get no path.
func NewPageTree(nodes []TreeNode) *PageTree {
	tree := &PageTree{
		byID:   make(map[string]TreeNode, len(nodes)),
		byPath: make(map[string]string, len(nodes)),
		paths:  make(map[string]string, len(nodes)),
	}
	for _, node := range nodes {
		tree.byID[node.ID] = node
	}

	for _, node := range nodes {
		path, ok := tree.computePath(node.ID)
		if !ok {
			continue
		}
		tree.paths[node.ID] = path
		tree.byPath[path] = node.ID
	}

	return tree
}

func (t *PageTree) computePath(id string) (string, bool) {
	segments := make([]string, 0, 4)
	visited := make(map[string]struct{})

	for current := id; current != ""; {
		if _, loop := visited[current]; loop {
			return "", false
		}
		visited[current] = struct{}{}

		node, ok := t.byID[current]
		if !ok {
			return "", false
		}
		segments = append(segments, node.Slug)
		current = node.ParentID
	}

	for i, j := 0, len(segments)-1; i < j; i, j = i+1, j-1 {
		segments[i], segments[j] = segments[j], segments[i]
	}

	return "/" + strings.Join(segments, "/"), true
}

// PageIDByPath implements PageResolver.
func (t *PageTree) PageIDByPath(path string) (string, bool) {
	id, ok := t.byPath[NormalizePagePath(path)]

	return id, ok
}

// PathByPageID implements PageResolver.
func (t *PageTree) PathByPageID(pageID string) (string, bool) {
	path, ok := t.paths[pageID]

	return path, ok
}

// Add registers a page that is being created in the same write, so links to
// it from other pages of that write resolve.
func (t *PageTree) Add(node TreeNode) {
	t.byID[node.ID] = node
	if path, ok := t.computePath(node.ID); ok {
		t.paths[node.ID] = path
		t.byPath[path] = node.ID
	}
}

// Ancestors returns the pages above a page, top level first. It stops at a
// broken or cyclic parent chain.
func (t *PageTree) Ancestors(pageID string) []TreeNode {
	chain := make([]TreeNode, 0, 4)
	visited := map[string]struct{}{pageID: {}}

	node, ok := t.byID[pageID]
	for ok && node.ParentID != "" {
		if _, loop := visited[node.ParentID]; loop {
			break
		}
		visited[node.ParentID] = struct{}{}

		node, ok = t.byID[node.ParentID]
		if ok {
			chain = append(chain, node)
		}
	}

	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	return chain
}

// Node returns a page of the tree.
func (t *PageTree) Node(pageID string) (TreeNode, bool) {
	node, ok := t.byID[pageID]

	return node, ok
}
