package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/knowledge"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}

	return strings.TrimSpace(string(out))
}

func TestLoadLocalCorpusSkipsGitAndFindsLintIssues(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		".git/team/wiki/concepts/ignored.md": "# ignored\n",
		"team/index.md":                      "# Team\n",
		"team/wiki/concepts/refund.md":       "# Refund\n\nSee [gone](gone.md).\n",
	})

	corpus, err := loadLocalCorpus(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := corpus.Pages["team/wiki/concepts/ignored.md"]; ok {
		t.Fatal(".git contents must not be read as pages")
	}

	codes := map[string]bool{}
	for _, is := range corpus.Lint("team") {
		codes[is.Code] = true
	}
	for _, want := range []string{knowledge.LintBrokenLink, knowledge.LintNotInIndex, knowledge.LintInvalidFrontMatter} {
		if !codes[want] {
			t.Errorf("expected lint code %s, got %v", want, codes)
		}
	}
}

func TestStaleAgainstLocalCodeCheckout(t *testing.T) {
	code := filepath.Join(t.TempDir(), "order-api")
	if err := os.MkdirAll(code, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, code, "init", "-q")
	writeFiles(t, code, map[string]string{"pay/callback.go": "package pay\n", "pay/refund.go": "package pay\n"})
	gitIn(t, code, "add", ".")
	gitIn(t, code, "commit", "-q", "-m", "init")
	checked := gitIn(t, code, "rev-parse", "HEAD")
	writeFiles(t, code, map[string]string{"pay/callback.go": "package pay\n\n// changed\n"})

	kb := t.TempDir()
	claims := `{"claims":[` +
		`{"id":"c1","text":"Callbacks dedupe.","evidence":[{"uri":"repo://order-api/pay/callback.go#L1","version":"` + checked + `"}]},` +
		`{"id":"c2","text":"Refunds are async.","evidence":[{"uri":"repo://order-api/pay/refund.go","version":"` + checked + `"}]},` +
		`{"id":"c3","text":"Old version.","evidence":[{"uri":"repo://order-api/pay/refund.go","version":"deadbeef"}]},` +
		`{"id":"c4","text":"Web.","evidence":[{"uri":"repo://web/app.ts","version":"` + checked + `"}]}]}`
	writeFiles(t, kb, map[string]string{
		"team/wiki/concepts/pay.md":              "---\ntype: concept\ntitle: Pay\n---\n\nBody.\n",
		"team/.claims/wiki/concepts/pay.md.json": claims,
	})

	repos, err := parseRepoFlags([]string{code})
	if err != nil {
		t.Fatal(err)
	}
	corpus, err := loadLocalCorpus(kb)
	if err != nil {
		t.Fatal(err)
	}
	items, err := corpus.Stale("team", time.Now(), repos)
	if err != nil {
		t.Fatal(err)
	}

	got := map[string]string{}
	for _, it := range items {
		got[it.ClaimID] = it.Reason
	}
	want := map[string]string{"c1": knowledge.StaleChanged, "c3": knowledge.StaleUnknownVersion, "c4": knowledge.StaleUnchecked}
	if len(got) != len(want) {
		t.Fatalf("stale items = %+v, want %v", items, want)
	}
	for id, reason := range want {
		if got[id] != reason {
			t.Errorf("claim %s reason = %q, want %q", id, got[id], reason)
		}
	}
}

func TestParseRepoFlags(t *testing.T) {
	cases := []struct {
		flags   []string
		names   []string
		wantErr bool
	}{
		{flags: []string{"api=/src/order-api"}, names: []string{"api"}},
		{flags: []string{"/src/order-api/"}, names: []string{"order-api"}},
		{flags: []string{"=/src/x"}, wantErr: true},
		{flags: []string{"api="}, wantErr: true},
		{flags: []string{"/a/api", "api=/b"}, wantErr: true},
	}
	for _, tc := range cases {
		repos, err := parseRepoFlags(tc.flags)
		if (err != nil) != tc.wantErr {
			t.Errorf("parseRepoFlags(%v) err = %v, wantErr %v", tc.flags, err, tc.wantErr)
			continue
		}
		for _, n := range tc.names {
			if repos[n] == nil {
				t.Errorf("parseRepoFlags(%v) missing repo %q", tc.flags, n)
			}
		}
	}
}
