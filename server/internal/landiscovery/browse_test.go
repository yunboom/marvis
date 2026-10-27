package landiscovery

import (
	"net"
	"reflect"
	"testing"

	"github.com/libp2p/zeroconf/v2"
)

func TestUnescapeDNS(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "name=abc", want: "name=abc"},
		{name: "decimal escapes", in: `name=\232\174\190`, want: "name=设"},
		{name: "quoted characters", in: `a\ b\.c\\d\"e`, want: `a b.c\d"e`},
		{name: "dangling backslash is kept", in: `abc\`, want: `abc\`},
		{name: "too short for decimal escape", in: `\12`, want: "12"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := unescapeDNS(tt.in); got != tt.want {
				t.Fatalf("unescapeDNS(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// serviceEntry 按 zeroconf 解包后的形态构造一条服务记录，中文以十进制转义出现。
func serviceEntry(instance string, text []string) *zeroconf.ServiceEntry {
	return &zeroconf.ServiceEntry{
		ServiceRecord: zeroconf.ServiceRecord{Instance: instance},
		HostName:      "marvis.local.",
		Port:          13840,
		Text:          text,
		AddrIPv4:      []net.IP{net.ParseIP("192.168.1.20")},
		AddrIPv6:      []net.IP{net.ParseIP("fe80::1")},
	}
}

func TestEntryFromService(t *testing.T) {
	svc := serviceEntry(`\232\174\190\ Marvis`, []string{
		"v=1",
		`name=\232\174\190\232\174\161\233\131\168\ Marvis`,
		"ver=v0.6.5",
		"id=7f3a",
	})

	got, ok := entryFromService(svc)
	if !ok {
		t.Fatal("entryFromService() rejected a valid entry")
	}

	want := Entry{
		Instance:      "设 Marvis",
		Name:          "设计部 Marvis",
		ServerVersion: "v0.6.5",
		InstanceID:    "7f3a",
		Host:          "marvis.local.",
		Port:          13840,
		IPs:           []net.IP{net.ParseIP("192.168.1.20"), net.ParseIP("fe80::1")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entryFromService() = %#v, want %#v", got, want)
	}
}

func TestEntryFromServiceFallsBackToInstanceName(t *testing.T) {
	got, ok := entryFromService(serviceEntry("studio", []string{"v=1", "id=7f3a"}))
	if !ok {
		t.Fatal("entryFromService() rejected a valid entry")
	}
	if got.Name != "studio" || got.ServerVersion != "" {
		t.Fatalf("Name = %q, ServerVersion = %q, want the instance name and an empty version", got.Name, got.ServerVersion)
	}
}

func TestEntryFromServiceSkipsOtherProtocolVersions(t *testing.T) {
	for _, text := range [][]string{nil, {"name=x"}, {"v=2", "name=x"}} {
		if _, ok := entryFromService(serviceEntry("studio", text)); ok {
			t.Fatalf("entryFromService() accepted TXT %v, want it skipped", text)
		}
	}
}
