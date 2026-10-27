package lint

import (
	"sort"
	"strings"
	"testing"

	"github.com/yunboom/marvis/server/internal/kb"
)

func codes(findings []Finding) string {
	out := make([]string, len(findings))
	for i, f := range findings {
		out[i] = f.Code
	}
	sort.Strings(out)

	return strings.Join(out, ",")
}

func TestCheckCleanPage(t *testing.T) {
	p := Page{
		ID:          "p1",
		Path:        "/a",
		Frontmatter: map[string]any{"type": "Guide", "title": "A", "description": "d"},
		Blocks: []kb.Block{
			{ID: "b1", Content: "Fact.[^s1]"},
			{ID: "b2", Content: "[^s1]: Source"},
		},
		Claims: []kb.Claim{{Key: "c1", BlockID: "b1", Text: "Fact.", Evidence: []kb.Evidence{
			{Source: "s1", URI: "repo://pay/a.go#L1-L2", Version: "abc"},
		}}},
		LinkedPages: 2,
		Inbound:     1,
	}

	if got := Check(p); len(got) != 0 {
		t.Errorf("clean page findings = %+v", got)
	}
}

func TestCheckTopLevelPageIsNotOrphan(t *testing.T) {
	p := Page{
		ID:          "p1",
		Path:        "/quickstart",
		Frontmatter: map[string]any{"type": "Guide", "title": "Quickstart", "description": "d"},
		LinkedPages: 2,
		TopLevel:    true,
	}
	if got := codes(Check(p)); got != "" {
		t.Errorf("top-level page findings = %s, want none", got)
	}

	p.TopLevel = false
	if got := codes(Check(p)); got != CodeOrphanPage {
		t.Errorf("nested page findings = %s, want %s", got, CodeOrphanPage)
	}
}

func TestCheckRules(t *testing.T) {
	p := Page{
		ID:          "p1",
		Path:        "/a",
		Frontmatter: map[string]any{"type": " "},
		Blocks: []kb.Block{
			{ID: "b1", Content: "Fact.[^s1] Other.[^s2]"},
			{ID: "b2", Content: "<<<<<<< 主线\na\n=======\nb\n>>>>>>> 草稿"},
		},
		Claims: []kb.Claim{
			{Key: "c1", BlockID: "b1", Evidence: []kb.Evidence{{Source: "s1", URI: "pr://pay#12"}}},
			{Key: "c2", BlockID: "b9", Evidence: []kb.Evidence{{Source: "s3", URI: "ftp://x"}}},
			{Key: "c3", BlockID: "b1"},
		},
		Conflicts:       []kb.Conflict{{Kind: kb.ConflictMeta, Key: "status"}},
		DuplicateSlug:   true,
		UnresolvedLinks: []string{"/todo"},
	}

	got := Check(p)
	want := "claim_without_evidence,claim_without_evidence,duplicate_slug,invalid_evidence_uri,isolated_page," +
		"missing_description,missing_evidence_version,missing_title,missing_type,orphan_page," +
		"undefined_footnote,unresolved_conflict,unresolved_conflict,unresolved_link"
	if codes(got) != want {
		t.Errorf("codes = %s\nwant    %s", codes(got), want)
	}
	if !HasErrors(got) {
		t.Error("HasErrors = false")
	}
	if got[0].Severity != SeverityError || got[len(got)-1].Severity != SeverityWarning {
		t.Errorf("errors must come first: %+v", got)
	}
}

func TestFootnoteRefs(t *testing.T) {
	got := FootnoteRefs("a[^x] b[^y] c[^x]\n[^z]: def")
	if strings.Join(got, ",") != "x,y" {
		t.Errorf("refs = %v", got)
	}
}
