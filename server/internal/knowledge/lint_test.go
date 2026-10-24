package knowledge

import (
	"slices"
	"testing"
)

const validPage = "---\ntype: concept\ntitle: Refund\ndescription: How refunds work.\ndomains: [dev]\n---\n\n# Refund\n\nRefunds go back to the original card.[^1] See [payment](../entities/payment.md).\n\n[^1]: task://MAR-1 Refund task\n"

const paymentPage = "---\ntype: entity\ntitle: Payment\ndescription: Payment service.\ndomains: [dev]\n---\n\n# Payment\n\nHandles callbacks. Related: [refund](../concepts/refund.md).\n"

const okIndex = "# Team\n\n- [Refund](wiki/concepts/refund.md)\n- [Payment](wiki/entities/payment.md)\n"

const okClaims = `{"claims":[{"id":"c1","text":"Refunds go back to the original card.","evidence":[{"uri":"task://MAR-1"}]}]}`

func corpusOf(files map[string]string) *Corpus {
	paths := make([]string, 0, len(files))
	contents := map[string][]byte{}
	for p, body := range files {
		paths = append(paths, p)
		contents[p] = []byte(body)
	}

	return NewCorpus("test", paths, contents)
}

// baseFiles 是一个没有 lint 问题的知识库，各用例在它上面改一处。
func baseFiles() map[string]string {
	return map[string]string{
		"team/index.md":                              okIndex,
		"team/wiki/concepts/refund.md":               validPage,
		"team/wiki/entities/payment.md":              paymentPage,
		"team/.claims/wiki/concepts/refund.md.json":  okClaims,
		"team/.claims/wiki/entities/payment.md.json": `{"claims":[]}`,
	}
}

func TestLint(t *testing.T) {
	t.Parallel()

	type want struct{ code, path string }
	cases := []struct {
		name   string
		mutate func(f map[string]string)
		want   []want
	}{
		{name: "clean", mutate: func(map[string]string) {}},
		{
			name: "broken link",
			mutate: func(f map[string]string) {
				f["team/wiki/entities/payment.md"] = paymentPage + "\nSee [gone](../concepts/gone.md).\n"
			},
			want: []want{{LintBrokenLink, "team/wiki/entities/payment.md"}},
		},
		{
			name: "orphan and not in index",
			mutate: func(f map[string]string) {
				f["team/wiki/howtos/deploy.md"] = "---\ntype: howto\ntitle: Deploy\ndescription: Deploy steps.\ndomains: [dev]\n---\n\nRun make.\n"
				f["team/.claims/wiki/howtos/deploy.md.json"] = `{"claims":[]}`
			},
			want: []want{{LintNotInIndex, "team/wiki/howtos/deploy.md"}, {LintOrphanPage, "team/wiki/howtos/deploy.md"}},
		},
		{
			name: "index links to missing page",
			mutate: func(f map[string]string) {
				f["team/index.md"] = okIndex + "- [Old](wiki/concepts/old.md)\n"
			},
			want: []want{{LintBrokenLink, "team/index.md"}},
		},
		{
			name: "missing index",
			mutate: func(f map[string]string) {
				delete(f, "team/index.md")
			},
			want: []want{{LintMissingIndex, "team/index.md"}},
		},
		{
			name: "missing fields",
			mutate: func(f map[string]string) {
				f["team/wiki/entities/payment.md"] = "---\ntype: entity\n---\n\nHandles callbacks. [refund](../concepts/refund.md)\n"
			},
			want: []want{
				{LintMissingField, "team/wiki/entities/payment.md"},
				{LintMissingField, "team/wiki/entities/payment.md"},
				{LintMissingField, "team/wiki/entities/payment.md"},
			},
		},
		{
			name: "no front matter",
			mutate: func(f map[string]string) {
				f["team/wiki/entities/payment.md"] = "# Payment\n\n[refund](../concepts/refund.md)\n"
			},
			want: []want{{LintInvalidFrontMatter, "team/wiki/entities/payment.md"}},
		},
		{
			name: "invalid values",
			mutate: func(f map[string]string) {
				f["team/wiki/entities/payment.md"] = "---\ntype: concept\ntitle: P\ndescription: D.\ndomains: [ops]\nstatus: draft\nstale_after: soon\n---\n\n[refund](../concepts/refund.md)\n"
			},
			want: []want{
				{LintInvalidValue, "team/wiki/entities/payment.md"},
				{LintInvalidValue, "team/wiki/entities/payment.md"},
				{LintInvalidValue, "team/wiki/entities/payment.md"},
				{LintInvalidValue, "team/wiki/entities/payment.md"},
			},
		},
		{
			name: "citation without footnote and unused footnote",
			mutate: func(f map[string]string) {
				f["team/wiki/entities/payment.md"] = paymentPage + "\nCallbacks retry.[^2]\n\n[^3]: task://MAR-3\n"
			},
			want: []want{{LintMissingFootnote, "team/wiki/entities/payment.md"}, {LintUnusedFootnote, "team/wiki/entities/payment.md"}},
		},
		{
			name: "claims problems",
			mutate: func(f map[string]string) {
				delete(f, "team/.claims/wiki/entities/payment.md.json")
				f["team/.claims/wiki/concepts/refund.md.json"] = `{"claims":[{"text":"no id","evidence":[{"uri":"repo://api/pay.go#L1-L2"}]}]}`
				f["team/.claims/wiki/concepts/gone.md.json"] = `not json`
			},
			want: []want{
				{LintClaimsWithoutPage, "team/.claims/wiki/concepts/gone.md.json"},
				{LintInvalidClaims, "team/.claims/wiki/concepts/gone.md.json"},
				{LintInvalidClaims, "team/.claims/wiki/concepts/refund.md.json"},
				{LintMissingVersion, "team/.claims/wiki/concepts/refund.md.json"},
				{LintMissingClaims, "team/wiki/entities/payment.md"},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			files := baseFiles()
			tc.mutate(files)
			got := corpusOf(files).Lint("team")

			gotPairs := make([]want, 0, len(got))
			for _, g := range got {
				gotPairs = append(gotPairs, want{g.Code, g.Path})
			}
			wantPairs := tc.want
			sortPairs := func(p []want) {
				slices.SortFunc(p, func(a, b want) int {
					if a.path != b.path {
						if a.path < b.path {
							return -1
						}
						return 1
					}
					if a.code < b.code {
						return -1
					}
					if a.code > b.code {
						return 1
					}
					return 0
				})
			}
			sortPairs(gotPairs)
			sortPairs(wantPairs)
			if !slices.Equal(gotPairs, wantPairs) {
				t.Fatalf("lint issues mismatch\n got: %+v\nwant: %+v\nfull: %+v", gotPairs, wantPairs, got)
			}
		})
	}
}

func TestLintScopesToSlug(t *testing.T) {
	t.Parallel()

	files := baseFiles()
	files["other/wiki/concepts/x.md"] = "# no front matter\n"

	if got := corpusOf(files).Lint("team"); len(got) != 0 {
		t.Fatalf("expected no issues for team, got %+v", got)
	}
	if got := corpusOf(files).Lint(""); len(got) == 0 {
		t.Fatalf("expected issues for the other knowledge base when slug is empty")
	}
}

func TestParseRepoURI(t *testing.T) {
	t.Parallel()

	cases := []struct {
		uri  string
		want RepoRef
		ok   bool
	}{
		{"repo://order-api/internal/pay/callback.go#L40-L82@3f2a91c", RepoRef{"order-api", "internal/pay/callback.go", "3f2a91c"}, true},
		{"repo://order-api/internal/pay/callback.go#L40-L82", RepoRef{"order-api", "internal/pay/callback.go", ""}, true},
		{"repo://order-api/main.go", RepoRef{"order-api", "main.go", ""}, true},
		{"repo://order-api", RepoRef{}, false},
		{"task://MAR-1", RepoRef{}, false},
	}
	for _, tc := range cases {
		got, ok := ParseRepoURI(tc.uri)
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseRepoURI(%q) = %+v, %v; want %+v, %v", tc.uri, got, ok, tc.want, tc.ok)
		}
	}
}
