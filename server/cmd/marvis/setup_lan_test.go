package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/landiscovery"
)

const (
	testLocalURL   = "http://localhost:13840"
	testLANURL     = "http://192.168.1.20:13840"
	testLocalWeb   = "http://localhost:3000"
	testLANWeb     = "http://192.168.1.20:3000"
	testThisName   = "studio"
	testMarvisHost = "marvis.local"
	testRemoteName = "设计部 Marvis"
)

func TestSanitizeLANText(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain text is kept", in: "设计部 Marvis", want: "设计部 Marvis"},
		{name: "terminal escape sequence is stripped", in: "evil\x1b[31mred\x1b[0m", want: "evil[31mred[0m"},
		{name: "c0 and c1 controls are stripped", in: "a\x00b\x07c\u0085d\u009be", want: "abcde"},
		{name: "newlines and tabs are stripped", in: "line1\nline2\tx", want: "line1line2x"},
		{name: "bidi overrides and isolates are stripped", in: "abc\u202edcba\u2066x\u2069\u200f", want: "abcdcbax"},
		{name: "invalid utf-8 is dropped", in: "ok\xffok", want: "okok"},
		{name: "surrounding spaces are trimmed", in: "  name  ", want: "name"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeLANText(tt.in); got != tt.want {
				t.Fatalf("sanitizeLANText(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeLANTextCapsLength(t *testing.T) {
	got := sanitizeLANText(strings.Repeat("设", 100))
	if n := utf8.RuneCountInString(got); n != maxLANTextRunes {
		t.Fatalf("sanitized length = %d runes, want %d", n, maxLANTextRunes)
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("truncated text %q must end with an ellipsis", got)
	}

	exact := strings.Repeat("a", maxLANTextRunes)
	if got := sanitizeLANText(exact); got != exact {
		t.Fatalf("text at the limit was changed: %q", got)
	}
}

func TestURLHostname(t *testing.T) {
	tests := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{in: "marvis.local.", want: testMarvisHost, wantOK: true},
		{in: "Marvis-2.LOCAL.", want: "marvis-2.local", wantOK: true},
		{in: "", wantOK: false},
		{in: "evil host.local.", wantOK: false},
		{in: "evil/path.local", wantOK: false},
		{in: "user@marvis.local", wantOK: false},
		{in: "marvis.local:80", wantOK: false},
		{in: "设计.local.", wantOK: false},
		{in: "\x1b[31m.local", wantOK: false},
		{in: ".local", wantOK: false},
	}

	for _, tt := range tests {
		got, ok := urlHostname(tt.in)
		if ok != tt.wantOK || got != tt.want {
			t.Fatalf("urlHostname(%q) = %q, %v, want %q, %v", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}

func TestEntryURLPrefersAnnouncedIPv4(t *testing.T) {
	tests := []struct {
		name   string
		entry  landiscovery.Entry
		want   string
		wantOK bool
	}{
		{
			name:   "private ipv4 wins over ipv6 and public ipv4",
			entry:  landiscovery.Entry{Host: "marvis.local.", Port: 13840, IPs: ips("fe80::1", "203.0.113.5", "192.168.1.20")},
			want:   testLANURL,
			wantOK: true,
		},
		{
			name:   "public ipv4 is used when it is the only ipv4",
			entry:  landiscovery.Entry{Host: "marvis.local.", Port: 13840, IPs: ips("203.0.113.5")},
			want:   "http://203.0.113.5:13840",
			wantOK: true,
		},
		{
			name:   "host name is the fallback without ipv4",
			entry:  landiscovery.Entry{Host: "Marvis.local.", Port: 13840, IPs: ips("fe80::1")},
			want:   defaultServerAddress,
			wantOK: true,
		},
		{
			name:   "invalid host name without ipv4 is dropped",
			entry:  landiscovery.Entry{Host: "evil host.local.", Port: 13840},
			wantOK: false,
		},
		{
			name:   "invalid host name does not matter with an ipv4",
			entry:  landiscovery.Entry{Host: "evil host.local.", Port: 13840, IPs: ips("192.168.1.20")},
			want:   testLANURL,
			wantOK: true,
		},
		{
			name:   "missing port is dropped",
			entry:  landiscovery.Entry{Host: "marvis.local.", IPs: ips("192.168.1.20")},
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := entryURL(tt.entry)
			if ok != tt.wantOK || got != tt.want {
				t.Fatalf("entryURL() = %q, %v, want %q, %v", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func ips(values ...string) []net.IP {
	out := make([]net.IP, 0, len(values))
	for _, v := range values {
		out = append(out, net.ParseIP(v))
	}

	return out
}

func TestMergeCandidatesSanitizesAnnouncements(t *testing.T) {
	found := []landiscovery.Entry{
		{Name: "evil\x1b]0;pwned\x07\u202e", ServerVersion: "0.6.5\n", Host: "marvis.local.", Port: 13840, InstanceID: "a", IPs: ips("192.168.1.20")},
		{Name: "bad host", Host: "bad host.local.", Port: 13840, InstanceID: "b"},
	}

	got := mergeCandidates(nil, nil, found)
	if len(got) != 1 {
		t.Fatalf("len: got %d (%+v), want the invalid host dropped", len(got), got)
	}
	if got[0].Name != "evil]0;pwned" || got[0].ServerVersion != "0.6.5" {
		t.Fatalf("candidate text was not sanitized: %+v", got[0])
	}
	if got[0].URL != testLANURL || got[0].Host != testMarvisHost {
		t.Fatalf("url = %q host = %q, want the ip url and the host name for display", got[0].URL, got[0].Host)
	}
}

func TestPrintCandidatesShowsHostNameForIPURLs(t *testing.T) {
	cands := []candidate{{URL: testLANURL, Host: testMarvisHost, Name: testRemoteName, ServerVersion: "0.6.5"}}
	var out strings.Builder

	printCandidates(&out, cands)

	if !strings.Contains(out.String(), "marvis.local:13840") || strings.Contains(out.String(), "192.168.1.20") {
		t.Fatalf("the menu shows the host name and port:\n%s", out.String())
	}
}

func TestFetchServerIdentitySanitizesFields(t *testing.T) {
	srv := newConfigServer(t, 200, `{
  "server_name": "evil\u001b[2Jname\u202e",
  "server_version": "0.6.5\r\n",
  "instance_id": "inst\u0007-a",
  "daemon_app_url": "http://192.168.1.20:3000/\u001b"
}`)

	got, err := fetchServerIdentity(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := serverIdentity{Name: "evil[2Jname", Version: "0.6.5", InstanceID: "inst-a"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestNormalizeWebAppURLKeepsLoopback(t *testing.T) {
	for in, want := range map[string]string{
		testLocalWeb + "/":           testLocalWeb,
		"http://127.0.0.1:3000":      "http://127.0.0.1:3000",
		"https://app.internal.co/":   "https://app.internal.co",
		"ftp://app.internal.co":      "",
		"":                           "",
		"http://app.\x1binternal.co": "",
	} {
		if got := normalizeWebAppURL(in); got != want {
			t.Fatalf("normalizeWebAppURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWebAppURLFor(t *testing.T) {
	tests := []struct {
		name   string
		appURL string
		local  bool
		want   string
	}{
		{name: "loopback web app on this computer", appURL: testLocalWeb, local: true, want: testLocalWeb},
		{name: "loopback web app on another computer", appURL: testLocalWeb, local: false, want: ""},
		{name: "ipv6 loopback on another computer", appURL: "http://[::1]:3000", local: false, want: ""},
		{name: "lan web app on another computer", appURL: testLANWeb, local: false, want: testLANWeb},
		{name: "no web app", appURL: "", local: true, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := webAppURLFor(tt.appURL, tt.local); got != tt.want {
				t.Fatalf("webAppURLFor(%q, %v) = %q, want %q", tt.appURL, tt.local, got, tt.want)
			}
		})
	}
}

func TestProbeTimeoutFor(t *testing.T) {
	for url, want := range map[string]time.Duration{
		defaultServerAddress:           mdnsProbeTimeout,
		"http://MARVIS-2.Local.:13840": mdnsProbeTimeout,
		testLANURL:                     identityTimeout,
		"https://api.example.com":      identityTimeout,
		"not a url":                    identityTimeout,
	} {
		if got := probeTimeoutFor(url, identityTimeout); got != want {
			t.Fatalf("probeTimeoutFor(%q) = %v, want %v", url, got, want)
		}
	}

	if mdnsProbeTimeout != 6*time.Second {
		t.Fatalf("mdnsProbeTimeout = %v, want 6s", mdnsProbeTimeout)
	}
}

func TestIsLocalServer(t *testing.T) {
	deps := discoverDeps{
		localAddrs: func() []net.IP { return ips("192.168.1.20", "10.8.0.2") },
		lookupHost: func(_ context.Context, host string) ([]net.IP, error) {
			switch host {
			case testMarvisHost:
				return ips("192.168.1.20"), nil
			case "marvis-2.local":
				return ips("192.168.1.31"), nil
			default:
				return nil, errors.New("no such host")
			}
		},
	}

	for url, want := range map[string]bool{
		testLocalURL:                 true,
		"http://127.0.0.1:13840":     true,
		"http://[::1]:13840":         true,
		testLANURL:                   true,
		"http://192.168.1.31:13840":  false,
		defaultServerAddress:         true,
		testSecondURL:                false,
		"http://unknown.local:13840": false,
	} {
		if got := isLocalServer(context.Background(), deps, url); got != want {
			t.Fatalf("isLocalServer(%q) = %v, want %v", url, got, want)
		}
	}
}

// newLocalFakes 在 newDiscoverFakes 的基础上加上本机地址：本机网卡地址为 192.168.1.20。
func newLocalFakes(desktop *cli.DesktopServer, found []landiscovery.Entry, identities map[string]serverIdentity) discoverDeps {
	deps := newDiscoverFakes(desktop, found, identities)
	deps.localAddrs = func() []net.IP { return ips("192.168.1.20") }
	deps.lookupHost = func(context.Context, string) ([]net.IP, error) { return nil, errors.New("no such host") }

	return deps
}

func TestDiscoverSelfHostServerListsThisComputerFirst(t *testing.T) {
	desktop := &cli.DesktopServer{URL: "http://192.168.1.31:13840", Name: testRemoteName, InstanceID: "b"}
	found := []landiscovery.Entry{
		{Name: testThisName, Host: "marvis.local.", Port: 13840, InstanceID: "a", IPs: ips("192.168.1.20")},
		{Name: testRemoteName, Host: "marvis-2.local.", Port: 13840, InstanceID: "b", IPs: ips("192.168.1.31")},
		{Name: "alpha", Host: "marvis-3.local.", Port: 13840, InstanceID: "c", IPs: ips("192.168.1.40")},
	}
	deps := newLocalFakes(desktop, found, map[string]serverIdentity{
		testLocalURL:                {Name: testThisName, Version: "0.6.5", InstanceID: "a", AppURL: testLocalWeb},
		testLANURL:                  {Name: testThisName, Version: "0.6.5", InstanceID: "a", AppURL: testLocalWeb},
		"http://192.168.1.31:13840": {Name: testRemoteName, Version: "0.6.5", InstanceID: "b"},
		"http://192.168.1.40:13840": {Name: "alpha", Version: "0.6.5", InstanceID: "c"},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 直接回车选中本机：回环的网页端地址在本机可用。
	if got.URL != testLocalURL || got.AppURL != testLocalWeb || !got.Local {
		t.Fatalf("got %+v, want this computer with its local web app", got)
	}

	rows := numberedRows(out.String())
	if len(rows) != 4 {
		t.Fatalf("want 3 servers and the manual entry, got:\n%s", out.String())
	}
	if !strings.Contains(rows[0], testThisName) || !strings.Contains(rows[0], thisComputerNote) {
		t.Fatalf("row 1 must be this computer: %q", rows[0])
	}
	if !strings.Contains(rows[1], testRemoteName) || !strings.Contains(rows[1], desktopInUseNote) {
		t.Fatalf("row 2 must be the desktop server: %q", rows[1])
	}
	if !strings.Contains(rows[2], "alpha") {
		t.Fatalf("row 3 must be the other server: %q", rows[2])
	}
	if !strings.Contains(out.String(), "found 3") {
		t.Fatalf("output:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerThisComputerUsedByDesktop(t *testing.T) {
	desktop := &cli.DesktopServer{URL: testLANURL, Name: testThisName, InstanceID: "a"}
	deps := newLocalFakes(desktop, nil, map[string]serverIdentity{
		testLocalURL: {Name: testThisName, Version: "0.6.5", InstanceID: "a", AppURL: testLocalWeb},
		testLANURL:   {Name: testThisName, Version: "0.6.5", InstanceID: "a", AppURL: testLocalWeb},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != testLocalURL {
		t.Fatalf("got %+v, want the localhost address", got)
	}

	rows := numberedRows(out.String())
	if len(rows) != 2 || !strings.Contains(rows[0], thisComputerNote) || !strings.Contains(rows[0], desktopInUseNote) {
		t.Fatalf("one merged row marked as both this computer and in use by desktop, got:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerWithoutLocalServer(t *testing.T) {
	found := []landiscovery.Entry{{Name: testRemoteName, Host: "marvis-2.local.", Port: 13840, InstanceID: "b", IPs: ips("192.168.1.31")}}
	deps := newLocalFakes(nil, found, map[string]serverIdentity{
		"http://192.168.1.31:13840": {Name: testRemoteName, Version: "0.6.5", InstanceID: "b", AppURL: testLocalWeb},
	})
	var out strings.Builder

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 另一台电脑上的服务器报的 localhost 网页端在这里打不开。
	if got.URL != "http://192.168.1.31:13840" || got.Local || webAppURLFor(got.AppURL, got.Local) != "" {
		t.Fatalf("got %+v, want the remote server without a usable web app", got)
	}
	if strings.Contains(out.String(), thisComputerNote) {
		t.Fatalf("no local server answered, output:\n%s", out.String())
	}
}

func TestDiscoverSelfHostServerProbesLocalhostConcurrently(t *testing.T) {
	deps := newLocalFakes(nil, nil, nil)

	browsing := make(chan struct{})
	deps.browse = func(context.Context, time.Duration) ([]landiscovery.Entry, error) {
		close(browsing)

		return nil, nil
	}
	deps.fetch = func(_ context.Context, baseURL string) (serverIdentity, error) {
		if baseURL != testLocalURL {
			return serverIdentity{}, errors.New("connection refused")
		}

		// 本机探测要等查找开始才返回；串行执行会在这里超时。
		select {
		case <-browsing:
			return serverIdentity{Name: testThisName, InstanceID: "a"}, nil
		case <-time.After(3 * time.Second):
			return serverIdentity{}, errors.New("localhost probe ran before the search")
		}
	}

	got, err := discoverSelfHostServer(context.Background(), deps, testLocalURL, strings.NewReader("\n"), io.Discard)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.URL != testLocalURL {
		t.Fatalf("got %+v", got)
	}
}

// numberedRows 取出菜单里带序号的行。
func numberedRows(output string) []string {
	var rows []string
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > 1 && trimmed[0] >= '1' && trimmed[0] <= '9' && trimmed[1] == '.' {
			rows = append(rows, line)
		}
	}

	return rows
}

func TestDescribeServerOmitsEmptyVersion(t *testing.T) {
	if got := describeServer(serverIdentity{Name: testThisName}, testLocalURL); got != "studio (http://localhost:13840)" {
		t.Fatalf("describeServer() = %q", got)
	}
}

func TestResolveSelfHostLogin(t *testing.T) {
	localPick := &discoveredServer{URL: testLocalURL, AppURL: testLocalWeb, Local: true}
	remoteLoopbackPick := &discoveredServer{URL: "http://192.168.1.31:13840", AppURL: testLocalWeb}
	remoteWebPick := &discoveredServer{URL: "http://192.168.1.31:13840", AppURL: "http://192.168.1.31:3000"}
	noWebPick := &discoveredServer{URL: "http://192.168.1.31:13840"}

	tests := []struct {
		name        string
		in          selfHostLoginInput
		wantAppURL  string
		wantAsk     bool
		wantBrowser bool
	}{
		{
			name:        "picked this computer keeps the loopback web app",
			in:          selfHostLoginInput{Picked: localPick, ServerURL: testLocalURL, FrontendPort: 3000},
			wantAppURL:  testLocalWeb,
			wantBrowser: true,
		},
		{
			name:       "picked another computer that reports a loopback web app",
			in:         selfHostLoginInput{Picked: remoteLoopbackPick, ServerURL: remoteLoopbackPick.URL, FrontendPort: 3000},
			wantAppURL: "",
		},
		{
			name:        "picked another computer with a lan web app",
			in:          selfHostLoginInput{Picked: remoteWebPick, ServerURL: remoteWebPick.URL, FrontendPort: 3000},
			wantAppURL:  "http://192.168.1.31:3000",
			wantBrowser: true,
		},
		{
			name:       "picked a server without a web app",
			in:         selfHostLoginInput{Picked: noWebPick, ServerURL: noWebPick.URL, FrontendPort: 3000},
			wantAppURL: "",
		},
		{
			name: "app url flag wins over the picked server",
			in: selfHostLoginInput{
				Picked: noWebPick, ExplicitAppURL: "https://app.internal.co",
				ConfiguredAppURL: "https://app.internal.co", ServerURL: noWebPick.URL, FrontendPort: 3000,
			},
			wantAppURL:  "https://app.internal.co",
			wantBrowser: true,
		},
		{
			name: "picker ignores an app url only found in the old config",
			in: selfHostLoginInput{
				Picked: noWebPick, ConfiguredAppURL: "https://old.internal.co", ServerURL: noWebPick.URL, FrontendPort: 3000,
			},
			wantAppURL: "",
		},
		{
			name:        "configured app url without the picker",
			in:          selfHostLoginInput{ConfiguredAppURL: "https://app.internal.co", ServerURL: "https://api.internal.co", UserProvidedServerURL: true},
			wantAppURL:  "https://app.internal.co",
			wantBrowser: true,
		},
		{
			name:    "remote server without an app url asks for one",
			in:      selfHostLoginInput{ServerURL: "https://api.internal.co", UserProvidedServerURL: true, FrontendPort: 3000},
			wantAsk: true,
		},
		{
			name:        "localhost default uses the frontend port",
			in:          selfHostLoginInput{ServerURL: testLocalURL, FrontendPort: 4000},
			wantAppURL:  "http://localhost:4000",
			wantBrowser: true,
		},
		{
			name:        "user supplied localhost server uses the frontend port",
			in:          selfHostLoginInput{ServerURL: "http://127.0.0.1:13840", UserProvidedServerURL: true, FrontendPort: 3000},
			wantAppURL:  testLocalWeb,
			wantBrowser: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveSelfHostLogin(tt.in)
			if got.AppURL != tt.wantAppURL || got.AskAppURL != tt.wantAsk || got.BrowserLogin() != tt.wantBrowser {
				t.Fatalf("resolveSelfHostLogin() = %+v (browser login %v), want app url %q ask %v browser login %v",
					got, got.BrowserLogin(), tt.wantAppURL, tt.wantAsk, tt.wantBrowser)
			}
		})
	}
}
