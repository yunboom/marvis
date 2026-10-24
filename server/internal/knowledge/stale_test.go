package knowledge

import (
	"slices"
	"testing"
	"time"
)

type fakeDiffer struct {
	versions map[string][]string
	calls    int
}

func (f *fakeDiffer) ChangedSince(version string) (map[string]bool, bool, error) {
	f.calls++
	files, ok := f.versions[version]
	if !ok {
		return nil, false, nil
	}
	changed := map[string]bool{}
	for _, p := range files {
		changed[p] = true
	}

	return changed, true, nil
}

func TestStale(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	page := func(staleAfter string) string {
		fm := "---\ntype: concept\ntitle: T\ndescription: D.\ndomains: [dev]\n"
		if staleAfter != "" {
			fm += "stale_after: " + staleAfter + "\n"
		}
		return fm + "---\n\nBody.\n"
	}
	claims := func(evidence string) string {
		return `{"claims":[{"id":"c1","text":"Callbacks dedupe.","evidence":[` + evidence + `]}]}`
	}

	type want struct{ reason, claimID string }
	cases := []struct {
		name       string
		staleAfter string
		evidence   string
		want       []want
	}{
		{name: "unchanged evidence", evidence: `{"uri":"repo://api/pay.go#L1-L9","version":"v1"}`},
		{name: "changed evidence", evidence: `{"uri":"repo://api/callback.go#L1-L9","version":"v1"}`, want: []want{{StaleChanged, "c1"}}},
		{name: "version inside uri", evidence: `{"uri":"repo://api/callback.go#L1@v1"}`, want: []want{{StaleChanged, "c1"}}},
		{name: "unknown version", evidence: `{"uri":"repo://api/pay.go","version":"zzz"}`, want: []want{{StaleUnknownVersion, "c1"}}},
		{name: "repo not given", evidence: `{"uri":"repo://web/app.ts","version":"v1"}`, want: []want{{StaleUnchecked, "c1"}}},
		{name: "no version", evidence: `{"uri":"repo://api/pay.go"}`, want: []want{{StaleUnchecked, "c1"}}},
		{name: "non code evidence ignored", evidence: `{"uri":"task://MAR-1"}`},
		{name: "expired page", staleAfter: "2026-10-01", evidence: `{"uri":"task://MAR-1"}`, want: []want{{StaleExpired, ""}}},
		{name: "future stale_after", staleAfter: "2027-01-01", evidence: `{"uri":"task://MAR-1"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := corpusOf(map[string]string{
				"team/wiki/concepts/a.md":              page(tc.staleAfter),
				"team/.claims/wiki/concepts/a.md.json": claims(tc.evidence),
			})
			differ := &fakeDiffer{versions: map[string][]string{"v1": {"callback.go"}}}

			items, err := c.Stale("team", now, map[string]RepoDiffer{"api": differ})
			if err != nil {
				t.Fatal(err)
			}
			got := make([]want, 0, len(items))
			for _, it := range items {
				got = append(got, want{it.Reason, it.ClaimID})
			}
			if !slices.Equal(got, tc.want) && (len(got) != 0 || len(tc.want) != 0) {
				t.Fatalf("stale items = %+v, want %+v", items, tc.want)
			}
		})
	}
}

func TestStaleDiffsEachVersionOnce(t *testing.T) {
	t.Parallel()

	ev := `{"uri":"repo://api/pay.go","version":"v1"}`
	files := map[string]string{}
	for _, name := range []string{"a", "b", "c"} {
		files["team/wiki/concepts/"+name+".md"] = "# x\n"
		files["team/.claims/wiki/concepts/"+name+".md.json"] = `{"claims":[{"id":"c1","evidence":[` + ev + `]},{"id":"c2","evidence":[` + ev + `]}]}`
	}
	differ := &fakeDiffer{versions: map[string][]string{"v1": {}}}

	if _, err := corpusOf(files).Stale("", time.Now(), map[string]RepoDiffer{"api": differ}); err != nil {
		t.Fatal(err)
	}
	if differ.calls != 1 {
		t.Fatalf("expected one diff per repo version, got %d", differ.calls)
	}
}
