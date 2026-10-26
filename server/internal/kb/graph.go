package kb

import (
	"sort"
	"strings"
)

// GraphNode is a page of the relationship graph, or a page not yet written
// that some page links to (Missing, no ID).
type GraphNode struct {
	// Key identifies the node in edges: the page id, or the path of a
	// missing page.
	Key     string
	ID      string
	Title   string
	Path    string
	Group   string
	Degree  int
	Missing bool
}

// GraphEdge is a link between two nodes, by node key.
type GraphEdge struct {
	From string
	To   string
}

// GraphLink is one mainline link: to a live page (ToPageID) or to a path
// nothing answers yet.
type GraphLink struct {
	FromPageID string
	ToPageID   string
	ToPath     string
}

// Graph is the relationship graph of a knowledge base.
type Graph struct {
	Nodes []GraphNode
	Edges []GraphEdge
}

// BuildGraph lays out the pages of a knowledge base and the links between
// them (spec 7.3). A node's group is its top-level page's title; a missing
// page is grouped under the live top-level page its path starts with, or the
// path's first segment. Degree counts distinct neighbours either way.
func BuildGraph(nodes []TreeNode, links []GraphLink) Graph {
	tree := NewPageTree(nodes)
	topByPath := make(map[string]string)
	out := Graph{Nodes: make([]GraphNode, 0, len(nodes)), Edges: make([]GraphEdge, 0, len(links))}
	index := make(map[string]int, len(nodes))

	for _, node := range nodes {
		path, ok := tree.PathByPageID(node.ID)
		if !ok {
			continue
		}

		group := node.Title
		if ancestors := tree.Ancestors(node.ID); len(ancestors) > 0 {
			group = ancestors[0].Title
		} else {
			topByPath[path] = node.Title
		}
		index[node.ID] = len(out.Nodes)
		out.Nodes = append(out.Nodes, GraphNode{Key: node.ID, ID: node.ID, Title: node.Title, Path: path, Group: group})
	}

	seen := make(map[GraphEdge]struct{}, len(links))
	neighbours := make(map[string]map[string]struct{})
	connect := func(a, b string) {
		if neighbours[a] == nil {
			neighbours[a] = map[string]struct{}{}
		}
		neighbours[a][b] = struct{}{}
	}

	for _, link := range links {
		if _, ok := index[link.FromPageID]; !ok {
			continue
		}

		to := link.ToPageID
		if to == "" {
			path := NormalizePagePath(link.ToPath)
			if id, ok := tree.PageIDByPath(path); ok {
				to = id
			} else {
				to = path
				if _, ok := index[to]; !ok {
					index[to] = len(out.Nodes)
					out.Nodes = append(out.Nodes, GraphNode{Key: to, Title: path, Path: path, Group: missingGroup(path, topByPath), Missing: true})
				}
			}
		}
		if _, ok := index[to]; !ok || to == link.FromPageID {
			continue
		}

		edge := GraphEdge{From: link.FromPageID, To: to}
		if _, dup := seen[edge]; dup {
			continue
		}
		seen[edge] = struct{}{}
		out.Edges = append(out.Edges, edge)
		connect(edge.From, edge.To)
		connect(edge.To, edge.From)
	}

	for i := range out.Nodes {
		out.Nodes[i].Degree = len(neighbours[out.Nodes[i].Key])
	}
	sort.SliceStable(out.Edges, func(i, j int) bool {
		if out.Edges[i].From != out.Edges[j].From {
			return out.Edges[i].From < out.Edges[j].From
		}
		return out.Edges[i].To < out.Edges[j].To
	})

	return out
}

func missingGroup(path string, topByPath map[string]string) string {
	first, _, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	if title, ok := topByPath["/"+first]; ok {
		return title
	}

	return first
}
