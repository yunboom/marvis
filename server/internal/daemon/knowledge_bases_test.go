package daemon

import (
	"encoding/json"
	"testing"

	"github.com/yunboom/marvis/server/internal/daemon/execenv"
)

// TestClaimKnowledgeBasesForEnv decodes the claim's knowledge base list into
// the brief context, and an old server's claim without the field into none.
func TestClaimKnowledgeBasesForEnv(t *testing.T) {
	cases := []struct {
		name          string
		claim         string
		want          []execenv.KnowledgeBaseForEnv
		wantTruncated bool
	}{
		{
			name:          "listed",
			claim:         `{"id":"t1","knowledge_bases":[{"slug":"team","name":"Team knowledge","description":"Orders."}],"knowledge_bases_truncated":true}`,
			want:          []execenv.KnowledgeBaseForEnv{{Slug: "team", Name: "Team knowledge", Description: "Orders."}},
			wantTruncated: true,
		},
		{name: "old server", claim: `{"id":"t1"}`},
		{name: "empty list", claim: `{"id":"t1","knowledge_bases":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var task Task
			if err := json.Unmarshal([]byte(tc.claim), &task); err != nil {
				t.Fatalf("decode claim: %v", err)
			}

			got := convertKnowledgeBasesForEnv(task.KnowledgeBases)
			if len(got) != len(tc.want) {
				t.Fatalf("knowledge bases = %+v, want %+v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("knowledge bases[%d] = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
			if task.KnowledgeBasesTruncated != tc.wantTruncated {
				t.Errorf("truncated = %v, want %v", task.KnowledgeBasesTruncated, tc.wantTruncated)
			}
		})
	}
}
