package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/landiscovery"
)

const (
	testSecondURL   = "http://marvis-2.local:13840"
	testManualURL   = "http://10.0.0.2:13840"
	testDesktopName = "设计部 Marvis"
)

func TestDefaultServerAddress(t *testing.T) {
	if defaultServerAddress != "http://marvis.local:13840" {
		t.Fatalf("default address: got %q", defaultServerAddress)
	}
}

func TestMergeCandidates(t *testing.T) {
	desktop := &cli.DesktopServer{URL: defaultServerAddress, Name: testDesktopName, InstanceID: "a"}
	found := []landiscovery.Entry{
		{Name: "marvis-dev", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
		{Name: testDesktopName, Host: "marvis.local.", Port: 13840, InstanceID: "a"},
		{Name: testDesktopName, Host: "marvis.local.", Port: 13840, InstanceID: "a"},
	}

	got := mergeCandidates(nil, desktop, found)
	if len(got) != 2 {
		t.Fatalf("len: got %d (%+v), want 2", len(got), got)
	}
	if !got[0].FromDesktop {
		t.Fatalf("first candidate must be the desktop one: %+v", got[0])
	}
	if got[0].URL != defaultServerAddress {
		t.Fatalf("desktop url: got %q", got[0].URL)
	}
	if got[1].URL != testSecondURL || got[1].FromDesktop {
		t.Fatalf("second candidate: got %+v", got[1])
	}
}

func TestMergeCandidatesBuildsURLFromIPv4(t *testing.T) {
	found := []landiscovery.Entry{
		{
			Name: "v6 first", Host: "marvis.local.", Port: 13840, InstanceID: "a",
			IPs: []net.IP{net.ParseIP("fe80::1"), net.ParseIP("192.168.1.20")},
		},
		{Name: "no host", Host: "", Port: 13840, InstanceID: "b", IPs: []net.IP{net.ParseIP("192.168.1.21")}},
		{Name: "no port", Host: "marvis-3.local.", Port: 0, InstanceID: "c", IPs: []net.IP{net.ParseIP("192.168.1.22")}},
		{Name: "nothing to connect to", Host: "", Port: 13840, InstanceID: "d"},
	}

	got := mergeCandidates(nil, nil, found)
	if len(got) != 2 {
		t.Fatalf("len: got %d (%+v), want 2", len(got), got)
	}
	if got[0].URL != "http://192.168.1.21:13840" || got[0].Host != "" {
		t.Fatalf("no host entry: got %+v", got[0])
	}
	if got[1].URL != testLANURL || got[1].Host != testMarvisHost {
		t.Fatalf("v6 first entry: got %+v", got[1])
	}
}

func TestMergeCandidatesWithoutDesktopIsSortedByName(t *testing.T) {
	found := []landiscovery.Entry{
		{Name: "zeta", Host: "marvis-3.local.", Port: 13840, InstanceID: "z", ServerVersion: "1.0.0"},
		{Name: "Alpha", Host: "marvis.local.", Port: 13840, InstanceID: "a", ServerVersion: "1.0.1"},
		{Name: "beta", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
	}

	got := mergeCandidates(nil, nil, found)
	names := make([]string, 0, len(got))
	for _, c := range got {
		names = append(names, c.Name)
		if c.FromDesktop {
			t.Fatalf("no desktop selection: %+v must not be FromDesktop", c)
		}
	}
	if strings.Join(names, ",") != "Alpha,beta,zeta" {
		t.Fatalf("order: got %v", names)
	}
	if got[0].ServerVersion != "1.0.1" || got[0].InstanceID != "a" {
		t.Fatalf("fields must carry over: %+v", got[0])
	}
}

func TestMergeCandidatesMatchesDesktopByInstanceID(t *testing.T) {
	// 桌面端用 IP 地址连接；同一台服务器经 mDNS 以主机名出现，应合并为一项。
	desktop := &cli.DesktopServer{URL: "http://192.168.1.20:13840", Name: "", InstanceID: "a"}
	found := []landiscovery.Entry{
		{Name: testDesktopName, Host: "marvis.local.", Port: 13840, InstanceID: "a", ServerVersion: "0.6.5"},
	}

	got := mergeCandidates(nil, desktop, found)
	if len(got) != 1 {
		t.Fatalf("len: got %d (%+v), want 1", len(got), got)
	}
	if got[0].URL != "http://192.168.1.20:13840" || !got[0].FromDesktop {
		t.Fatalf("desktop url must win: %+v", got[0])
	}
	if got[0].Name != testDesktopName || got[0].ServerVersion != "0.6.5" {
		t.Fatalf("name and version must come from the announcement: %+v", got[0])
	}
}

func TestMergeCandidatesDesktopOnlyFallsBackToHostName(t *testing.T) {
	desktop := &cli.DesktopServer{URL: "http://192.168.1.20:13840"}

	got := mergeCandidates(nil, desktop, nil)
	if len(got) != 1 || got[0].Name != "192.168.1.20:13840" {
		t.Fatalf("got %+v", got)
	}
}

func TestPickServerDefaultsToFirstAndAcceptsManualAddress(t *testing.T) {
	cands := []candidate{{URL: defaultServerAddress, Name: testDesktopName, FromDesktop: true}}

	got, err := pickServer(strings.NewReader("\n"), io.Discard, cands, func(string) bool { return true })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != defaultServerAddress {
		t.Fatalf("got %q", got)
	}

	got, err = pickServer(strings.NewReader("2\nhttp://192.168.1.58:13840\n"), io.Discard, cands, func(string) bool { return true })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "http://192.168.1.58:13840" {
		t.Fatalf("got %q", got)
	}
}

func TestPickServerChoosesByNumber(t *testing.T) {
	cands := []candidate{
		{URL: defaultServerAddress, Name: "one"},
		{URL: testSecondURL, Name: "two"},
	}

	got, err := pickServer(strings.NewReader("2\n"), io.Discard, cands, func(string) bool { return false })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != testSecondURL {
		t.Fatalf("got %q", got)
	}
}

func TestPickServerAsksAgainOnInvalidChoice(t *testing.T) {
	cands := []candidate{{URL: defaultServerAddress, Name: "one"}}
	var out strings.Builder

	got, err := pickServer(strings.NewReader("abc\n0\n9\n1\n"), &out, cands, func(string) bool { return true })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != defaultServerAddress {
		t.Fatalf("got %q", got)
	}
	if strings.Count(out.String(), "Enter a number from 1 to 2.") != 3 {
		t.Fatalf("want three re-prompts, output:\n%s", out.String())
	}
}

func TestPickServerManualAddress(t *testing.T) {
	t.Run("no candidates goes straight to the address prompt with the default", func(t *testing.T) {
		var probed []string
		var out strings.Builder

		got, err := pickServer(strings.NewReader("\n"), &out, nil, func(u string) bool {
			probed = append(probed, u)
			return true
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != defaultServerAddress {
			t.Fatalf("got %q", got)
		}
		if len(probed) != 1 || probed[0] != defaultServerAddress {
			t.Fatalf("probed: %v", probed)
		}
		if strings.Contains(out.String(), "Enter an address manually") {
			t.Fatalf("an empty list must not render the menu:\n%s", out.String())
		}
	})

	t.Run("adds the scheme and probes before accepting", func(t *testing.T) {
		var probed []string

		got, err := pickServer(strings.NewReader("192.168.1.58:13840\n"), io.Discard, nil, func(u string) bool {
			probed = append(probed, u)
			return true
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "http://192.168.1.58:13840" || len(probed) != 1 || probed[0] != got {
			t.Fatalf("got %q probed %v", got, probed)
		}
	})

	t.Run("unreachable address asks again", func(t *testing.T) {
		var out strings.Builder

		got, err := pickServer(
			strings.NewReader("http://10.0.0.1:13840\nhttp://10.0.0.2:13840\n"),
			&out, nil,
			func(u string) bool { return u == testManualURL },
		)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != testManualURL {
			t.Fatalf("got %q", got)
		}
		if !strings.Contains(out.String(), "cannot reach http://10.0.0.1:13840") {
			t.Fatalf("missing unreachable notice:\n%s", out.String())
		}
	})

	t.Run("rejects addresses that are not http or https", func(t *testing.T) {
		var probed []string

		got, err := pickServer(
			strings.NewReader("ftp://example.com\n://\nhttps://marvis.example.com\n"),
			io.Discard, nil,
			func(u string) bool {
				probed = append(probed, u)
				return true
			},
		)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "https://marvis.example.com" || len(probed) != 1 {
			t.Fatalf("got %q probed %v", got, probed)
		}
	})

	t.Run("closed input is an error", func(t *testing.T) {
		if _, err := pickServer(strings.NewReader(""), io.Discard, nil, func(string) bool { return true }); err == nil {
			t.Fatalf("want an error when stdin is closed")
		}

		cands := []candidate{{URL: defaultServerAddress, Name: "one"}}
		if _, err := pickServer(strings.NewReader(""), io.Discard, cands, func(string) bool { return true }); err == nil {
			t.Fatalf("want an error when stdin is closed at the menu")
		}
	})

	t.Run("last line without newline is still read", func(t *testing.T) {
		got, err := pickServer(strings.NewReader(testManualURL), io.Discard, nil, func(string) bool { return true })
		if err != nil || got != testManualURL {
			t.Fatalf("got %q err %v", got, err)
		}
	})
}

func TestPickServerListsCandidates(t *testing.T) {
	cands := []candidate{
		{URL: defaultServerAddress, Name: testDesktopName, ServerVersion: "0.6.5", FromDesktop: true},
		{URL: testSecondURL, Name: "marvis-dev", ServerVersion: "0.6.5"},
	}
	var out strings.Builder

	if _, err := pickServer(strings.NewReader("\n"), &out, cands, func(string) bool { return true }); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	lines := strings.Split(out.String(), "\n")
	var rows []string
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "1.") || strings.HasPrefix(strings.TrimSpace(line), "2.") || strings.HasPrefix(strings.TrimSpace(line), "3.") {
			rows = append(rows, line)
		}
	}
	if len(rows) != 3 {
		t.Fatalf("want 3 numbered rows, got %d:\n%s", len(rows), out.String())
	}
	for _, want := range []string{testDesktopName, "marvis.local:13840", "v0.6.5", "in use by desktop"} {
		if !strings.Contains(rows[0], want) {
			t.Fatalf("row 1 missing %q: %q", want, rows[0])
		}
	}
	if strings.Contains(rows[1], "in use by desktop") || !strings.Contains(rows[1], "marvis-2.local:13840") {
		t.Fatalf("row 2: %q", rows[1])
	}
	if !strings.Contains(rows[2], "Enter an address manually") {
		t.Fatalf("row 3: %q", rows[2])
	}
	if strings.Contains(out.String(), "http://marvis.local:13840 ") {
		t.Fatalf("rows show host:port without the scheme:\n%s", out.String())
	}
}

func TestDisplayWidthCountsWideCharacters(t *testing.T) {
	for in, want := range map[string]int{
		"":              0,
		"marvis":        6,
		"设计部":           6,
		testDesktopName: 13,
		"café":          4,
		"ＡＢ":            4,
		"한국어":           6,
		"サーバー":          8,
		"mixed 服务器 ok":  15,
	} {
		if got := displayWidth(in); got != want {
			t.Fatalf("displayWidth(%q): got %d, want %d", in, got, want)
		}
	}
}

func TestNormalizeWebAppURL(t *testing.T) {
	for in, want := range map[string]string{
		"":                           "",
		"http://localhost:3000":      "http://localhost:3000",
		"https://app.internal.co":    "https://app.internal.co",
		"https://app.internal.co/":   "https://app.internal.co",
		"http://192.168.1.20:3000":   "http://192.168.1.20:3000",
		"http://marvis.local:3000":   "http://marvis.local:3000",
		"https://x.co/marvis-app/":   "https://x.co/marvis-app",
		"not a url":                  "",
		"ftp://app.example.com":      "",
		"http://":                    "",
		"  https://app.internal.co ": "https://app.internal.co",
	} {
		if got := normalizeWebAppURL(in); got != want {
			t.Fatalf("normalizeWebAppURL(%q): got %q, want %q", in, got, want)
		}
	}
}

// newConfigServer 启动一个只回答 /api/config 的假服务器。
func newConfigServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/config" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)

	return srv
}

func TestFetchServerIdentity(t *testing.T) {
	t.Run("reads identity and applies the web app rule", func(t *testing.T) {
		srv := newConfigServer(t, http.StatusOK, `{
  "server_name": "设计部 Marvis",
  "server_version": "0.6.5",
  "instance_id": "inst-a",
  "daemon_app_url": "http://192.168.1.20:3000/"
}`)

		got, err := fetchServerIdentity(context.Background(), srv.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := serverIdentity{Name: testDesktopName, Version: "0.6.5", InstanceID: "inst-a", AppURL: "http://192.168.1.20:3000"}
		if got != want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("loopback app url is kept for the local server check", func(t *testing.T) {
		srv := newConfigServer(t, http.StatusOK, `{"instance_id": "inst-a", "daemon_app_url": "http://localhost:3000"}`)

		got, err := fetchServerIdentity(context.Background(), srv.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.AppURL != "http://localhost:3000" {
			t.Fatalf("app url: want the loopback address, got %q", got.AppURL)
		}
	})

	t.Run("old server without instance id still decodes", func(t *testing.T) {
		srv := newConfigServer(t, http.StatusOK, `{"allow_signup": true}`)

		got, err := fetchServerIdentity(context.Background(), srv.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.InstanceID != "" {
			t.Fatalf("instance id: want empty, got %q", got.InstanceID)
		}
	})

	t.Run("trailing slash in the base url is tolerated", func(t *testing.T) {
		srv := newConfigServer(t, http.StatusOK, `{"instance_id": "inst-a"}`)

		if _, err := fetchServerIdentity(context.Background(), srv.URL+"/"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("failures are errors", func(t *testing.T) {
		for name, srv := range map[string]*httptest.Server{
			"server error": newConfigServer(t, http.StatusInternalServerError, `{}`),
			"not json":     newConfigServer(t, http.StatusOK, `<html>`),
		} {
			if _, err := fetchServerIdentity(context.Background(), srv.URL); err == nil {
				t.Fatalf("%s: want an error", name)
			}
		}

		closed := httptest.NewServer(http.NotFoundHandler())
		closedURL := closed.URL
		closed.Close()
		if _, err := fetchServerIdentity(context.Background(), closedURL); err == nil {
			t.Fatalf("closed server: want an error")
		}
	})
}

func TestVerifyCandidates(t *testing.T) {
	cands := []candidate{
		{URL: defaultServerAddress, Name: "stale name", FromDesktop: true},
		{URL: testSecondURL, Name: "marvis-dev"},
		{URL: "http://marvis-3.local:13840", Name: "down"},
		{URL: "http://marvis-4.local:13840", Name: "too old"},
	}
	fetch := func(_ context.Context, baseURL string) (serverIdentity, error) {
		switch baseURL {
		case defaultServerAddress:
			return serverIdentity{Name: testDesktopName, Version: "0.6.5", InstanceID: "a", AppURL: "http://192.168.1.20:3000"}, nil
		case testSecondURL:
			return serverIdentity{Name: "marvis-dev", Version: "0.6.6", InstanceID: "b"}, nil
		case "http://marvis-4.local:13840":
			return serverIdentity{Version: "0.5.0"}, nil
		default:
			return serverIdentity{}, errors.New("connection refused")
		}
	}

	got, identities := verifyCandidates(context.Background(), cands, nil, fetch)
	if len(got) != 2 {
		t.Fatalf("len: got %d (%+v), want 2", len(got), got)
	}
	if got[0].Name != testDesktopName || got[0].ServerVersion != "0.6.5" || got[0].InstanceID != "a" || !got[0].FromDesktop {
		t.Fatalf("desktop candidate must be refreshed from /api/config: %+v", got[0])
	}
	if got[1].URL != testSecondURL || got[1].ServerVersion != "0.6.6" || got[1].InstanceID != "b" {
		t.Fatalf("second candidate: %+v", got[1])
	}
	if identities[defaultServerAddress].AppURL != "http://192.168.1.20:3000" {
		t.Fatalf("identities must keep the app url: %+v", identities)
	}
	if _, ok := identities["http://marvis-3.local:13840"]; ok {
		t.Fatalf("failed probes must not be recorded: %+v", identities)
	}
}

func TestVerifyCandidatesKeepsUnreachableDesktopServer(t *testing.T) {
	cands := []candidate{{URL: defaultServerAddress, Name: testDesktopName, InstanceID: "a", FromDesktop: true}}
	fetch := func(context.Context, string) (serverIdentity, error) {
		return serverIdentity{}, errors.New("connection refused")
	}

	got, identities := verifyCandidates(context.Background(), cands, nil, fetch)
	if len(got) != 1 || got[0].Name != testDesktopName || !got[0].FromDesktop {
		t.Fatalf("the server the desktop uses stays selectable: %+v", got)
	}
	if len(identities) != 0 {
		t.Fatalf("identities: %+v", identities)
	}
}

func TestVerifyCandidatesProbesConcurrently(t *testing.T) {
	const count = 4

	cands := make([]candidate, 0, count)
	for _, host := range []string{"a", "b", "c", "d"} {
		cands = append(cands, candidate{URL: "http://" + host + ".local:13840", Name: host})
	}

	// 每个探测都要等其余探测到齐才返回；串行执行会在这里超时。
	var (
		arrived int32
		all     = make(chan struct{})
	)
	fetch := func(ctx context.Context, baseURL string) (serverIdentity, error) {
		if atomic.AddInt32(&arrived, 1) == count {
			close(all)
		}
		select {
		case <-all:
			return serverIdentity{Name: baseURL, InstanceID: baseURL}, nil
		case <-time.After(3 * time.Second):
			return serverIdentity{}, errors.New("probes ran serially")
		}
	}

	got, _ := verifyCandidates(context.Background(), cands, nil, fetch)
	if len(got) != count {
		t.Fatalf("all probes must succeed together, got %d", len(got))
	}
}

func TestCountAnnounced(t *testing.T) {
	cands := []candidate{
		{URL: "http://192.168.1.20:13840", InstanceID: "a", FromDesktop: true},
		{URL: testSecondURL, InstanceID: "b"},
		{URL: "http://10.0.0.5:13840", InstanceID: "z", FromDesktop: false},
	}
	found := []landiscovery.Entry{
		{Host: "marvis.local.", Port: 13840, InstanceID: "a"},
		{Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
	}

	if got := countAnnounced(cands, found); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
	if got := countAnnounced(cands, nil); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}

// newDiscoverFakes 返回全部由假实现组成的依赖，避免单测触网。
func newDiscoverFakes(desktop *cli.DesktopServer, found []landiscovery.Entry, identities map[string]serverIdentity) discoverDeps {
	return discoverDeps{
		desktop: func() (cli.DesktopServer, bool) {
			if desktop == nil {
				return cli.DesktopServer{}, false
			}
			return *desktop, true
		},
		browse: func(context.Context, time.Duration) ([]landiscovery.Entry, error) { return found, nil },
		fetch: func(_ context.Context, baseURL string) (serverIdentity, error) {
			if id, ok := identities[baseURL]; ok {
				return id, nil
			}
			return serverIdentity{}, errors.New("connection refused")
		},
		probe:      func(u string) bool { _, ok := identities[u]; return ok },
		localAddrs: func() []net.IP { return nil },
		lookupHost: func(context.Context, string) ([]net.IP, error) { return nil, errors.New("no such host") },
	}
}

func TestDiscoverSelfHostServerPicksDesktopServer(t *testing.T) {
	desktop := &cli.DesktopServer{URL: defaultServerAddress, Name: testDesktopName, InstanceID: "a"}
	found := []landiscovery.Entry{
		{Name: testDesktopName, Host: "marvis.local.", Port: 13840, InstanceID: "a"},
		{Name: "marvis-dev", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
	}
	deps := newDiscoverFakes(desktop, found, map[string]serverIdentity{
		defaultServerAddress: {Name: testDesktopName, Version: "0.6.5", InstanceID: "a", AppURL: "http://192.168.1.20:3000"},
		testSecondURL:        {Name: "marvis-dev", Version: "0.6.5", InstanceID: "b"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != defaultServerAddress || got.AppURL != "http://192.168.1.20:3000" {
		t.Fatalf("got %+v", got)
	}
	for _, want := range []string{
		"Desktop is using: 设计部 Marvis",
		"Looking for Marvis servers on the local network… found 2",
		"in use by desktop",
		"marvis-dev",
		"Enter an address manually",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
}

func TestDiscoverSelfHostServerPickedServerWithoutWebApp(t *testing.T) {
	found := []landiscovery.Entry{{Name: "marvis-dev", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"}}
	deps := newDiscoverFakes(nil, found, map[string]serverIdentity{
		testSecondURL: {Name: "marvis-dev", Version: "0.6.5", InstanceID: "b"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("1\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != testSecondURL || got.AppURL != "" {
		t.Fatalf("got %+v", got)
	}
	if strings.Contains(out.String(), "Desktop is using") {
		t.Fatalf("no desktop selection, but output says otherwise:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerNothingFound(t *testing.T) {
	deps := newDiscoverFakes(nil, nil, map[string]serverIdentity{
		defaultServerAddress: {Name: testDesktopName, Version: "0.6.5", InstanceID: "a", AppURL: "https://app.internal.co"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != defaultServerAddress || got.AppURL != "https://app.internal.co" {
		t.Fatalf("got %+v", got)
	}
	for _, want := range []string{
		"Looking for Marvis servers on the local network… none found",
		"The computer and the server need to be on the same local network.",
		"Server address [http://marvis.local:13840]:",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
}

func TestDiscoverSelfHostServerNothingFoundKeepsDesktopServer(t *testing.T) {
	desktop := &cli.DesktopServer{URL: defaultServerAddress, Name: testDesktopName, InstanceID: "a"}
	deps := newDiscoverFakes(desktop, nil, map[string]serverIdentity{
		defaultServerAddress: {Name: testDesktopName, InstanceID: "a"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != defaultServerAddress {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(out.String(), "none found") || !strings.Contains(out.String(), "in use by desktop") {
		t.Fatalf("output:\n%s", out.String())
	}
	if strings.Contains(out.String(), "same local network") {
		t.Fatalf("the network hint is only for an empty list:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerDropsUnverifiedAnnouncements(t *testing.T) {
	found := []landiscovery.Entry{
		{Name: "good", Host: "marvis.local.", Port: 13840, InstanceID: "a"},
		{Name: "impostor", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
	}
	deps := newDiscoverFakes(nil, found, map[string]serverIdentity{
		defaultServerAddress: {Name: "good", InstanceID: "a"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != defaultServerAddress {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(out.String(), "found 1") || strings.Contains(out.String(), "impostor") {
		t.Fatalf("an announcement that fails /api/config must not be listed:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerBrowseFailureFallsBackToManualEntry(t *testing.T) {
	deps := newDiscoverFakes(nil, nil, map[string]serverIdentity{
		testManualURL: {Name: "lan", InstanceID: "a"},
	})
	deps.browse = func(context.Context, time.Duration) ([]landiscovery.Entry, error) {
		return nil, errors.New("no multicast interface")
	}
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("http://10.0.0.2:13840\n"), &out)
	if err != nil {
		t.Fatalf("a failed search must not stop manual entry: %v", err)
	}
	if got.URL != testManualURL {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(out.String(), "no multicast interface") {
		t.Fatalf("the search failure must be shown:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerManualServerWithUnreadableConfig(t *testing.T) {
	deps := newDiscoverFakes(nil, nil, nil)
	deps.probe = func(string) bool { return true }
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("http://10.0.0.2:13840\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != testManualURL || got.AppURL != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestDiscoverSelfHostServerClosedInput(t *testing.T) {
	deps := newDiscoverFakes(nil, nil, nil)

	if _, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader(""), io.Discard); err == nil {
		t.Fatalf("want an error when no server is chosen")
	}
}

func TestShouldDiscoverSelfHostServer(t *testing.T) {
	newCmd := func(t *testing.T, set map[string]string) *cobra.Command {
		t.Helper()

		cmd := &cobra.Command{Use: "self-host"}
		cmd.Flags().Int("port", 13840, "")
		cmd.Flags().Int("frontend-port", 3000, "")
		for name, value := range set {
			if err := cmd.Flags().Set(name, value); err != nil {
				t.Fatalf("set %s: %v", name, err)
			}
		}

		return cmd
	}

	t.Run("interactive with no server supplied", func(t *testing.T) {
		if !shouldDiscoverSelfHostServer(newCmd(t, nil), false, true) {
			t.Fatalf("want discovery")
		}
	})
	t.Run("not a terminal", func(t *testing.T) {
		if shouldDiscoverSelfHostServer(newCmd(t, nil), false, false) {
			t.Fatalf("a non-interactive run must keep the old behavior")
		}
	})
	t.Run("a server was supplied by flag, env or config", func(t *testing.T) {
		if shouldDiscoverSelfHostServer(newCmd(t, nil), true, true) {
			t.Fatalf("a supplied server must not be replaced by a picker")
		}
	})
	t.Run("explicit --port keeps the localhost path", func(t *testing.T) {
		if shouldDiscoverSelfHostServer(newCmd(t, map[string]string{"port": "9090"}), false, true) {
			t.Fatalf("--port means localhost, no picker")
		}
	})
	t.Run("explicit --frontend-port keeps the localhost path", func(t *testing.T) {
		if shouldDiscoverSelfHostServer(newCmd(t, map[string]string{"frontend-port": "4000"}), false, true) {
			t.Fatalf("--frontend-port means localhost, no picker")
		}
	})
}

func TestIsTerminalFile(t *testing.T) {
	regular, err := os.Create(filepath.Join(t.TempDir(), "stdin.txt"))
	if err != nil {
		t.Fatalf("create file: %v", err)
	}
	defer func() { _ = regular.Close() }()
	if isTerminalFile(regular) {
		t.Fatalf("a regular file is not a terminal")
	}

	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open %s: %v", os.DevNull, err)
	}
	defer func() { _ = devNull.Close() }()
	if isTerminalFile(devNull) {
		t.Fatalf("%s is a character device but not a terminal", os.DevNull)
	}

	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer func() { _ = reader.Close() }()
	defer func() { _ = writer.Close() }()
	if isTerminalFile(reader) {
		t.Fatalf("a pipe is not a terminal")
	}

	closed, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	_ = closed.Close()
	if isTerminalFile(closed) {
		t.Fatalf("a closed file is not a terminal")
	}
}

func TestPrintNoWebAppGuidance(t *testing.T) {
	var out strings.Builder

	printNoWebAppGuidance(&out)

	want := "No web app is configured for this server. Log in with `marvis login --token` using a token from Marvis Desktop → Settings → API Token.\n"
	if out.String() != want {
		t.Fatalf("got %q, want %q", out.String(), want)
	}
}
