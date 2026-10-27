package kb

import "testing"

func TestBuildGraph(t *testing.T) {
	nodes := []TreeNode{
		{ID: "p-pay", Slug: "payment", Title: "支付"},
		{ID: "p-cb", ParentID: "p-pay", Slug: "callback", Title: "支付回调"},
		{ID: "p-idem", ParentID: "p-pay", Slug: "idempotency", Title: "幂等键"},
		{ID: "p-test", Slug: "testing", Title: "测试"},
		{ID: "p-lone", Slug: "lone", Title: "孤立页面"},
	}
	links := []GraphLink{
		{FromPageID: "p-cb", ToPageID: "p-idem"},
		{FromPageID: "p-cb", ToPageID: "p-idem"}, // another block, same pages
		{FromPageID: "p-idem", ToPageID: "p-cb"},
		{FromPageID: "p-cb", ToPageID: "p-pay"},
		{FromPageID: "p-cb", ToPath: "/payment/refund"},
		{FromPageID: "p-test", ToPath: "/testing"}, // a path that now resolves
		{FromPageID: "p-test", ToPath: "/release/flow"},
		{FromPageID: "p-cb", ToPageID: "p-cb"},   // self link
		{FromPageID: "p-gone", ToPageID: "p-cb"}, // from a page not in the tree
	}

	graph := BuildGraph(nodes, links)

	byKey := map[string]GraphNode{}
	for _, node := range graph.Nodes {
		byKey[node.Key] = node
	}
	if len(graph.Nodes) != 7 {
		t.Fatalf("nodes = %+v", graph.Nodes)
	}

	cases := []struct {
		key     string
		group   string
		degree  int
		missing bool
	}{
		{"p-pay", "支付", 1, false},
		{"p-cb", "支付", 3, false},
		{"p-idem", "支付", 1, false},
		{"p-test", "测试", 1, false},
		{"p-lone", "孤立页面", 0, false},
		{"/payment/refund", "支付", 1, true},
		{"/release/flow", "release", 1, true},
	}
	for _, c := range cases {
		node, ok := byKey[c.key]
		if !ok {
			t.Errorf("node %s missing", c.key)
			continue
		}
		if node.Group != c.group || node.Degree != c.degree || node.Missing != c.missing {
			t.Errorf("node %s = %+v, want group=%s degree=%d missing=%v", c.key, node, c.group, c.degree, c.missing)
		}
		if c.missing && (node.ID != "" || node.Title != c.key) {
			t.Errorf("missing node %s = %+v", c.key, node)
		}
	}

	// p-cb→p-idem, p-idem→p-cb, p-cb→p-pay, p-cb→refund, p-test→release.
	if len(graph.Edges) != 5 {
		t.Errorf("edges = %+v", graph.Edges)
	}
}
