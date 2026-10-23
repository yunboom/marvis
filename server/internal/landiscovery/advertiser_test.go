package landiscovery

import (
	"net"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/miekg/dns"
)

func TestInstanceLabel(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain ascii", in: "MacBook-Pro", want: "MacBook-Pro"},
		{name: "space and dot are escaped", in: "Design Mac.mini", want: `Design\ Mac\.mini`},
		{name: "non ascii bytes become decimal escapes", in: "设", want: `\232\174\190`},
		{name: "backslash is escaped", in: `a\b`, want: `a\\b`},
		{name: "leading and trailing dots are dropped", in: ".studio.", want: "studio"},
		{name: "empty falls back to the default hostname", in: " . ", want: DefaultHostname},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := instanceLabel(tt.in); got != tt.want {
				t.Fatalf("instanceLabel(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestInstanceLabelFitsDNSLabelLimit(t *testing.T) {
	// 30 个汉字共 90 字节，超过 DNS 标签 63 字节的上限，应在字符边界截断为 21 个汉字。
	got := instanceLabel(strings.Repeat("设", 30))
	if want := strings.Repeat(`\232\174\190`, 21); got != want {
		t.Fatalf("instanceLabel() = %q, want %q", got, want)
	}

	if raw := unescapeDNS(got); len(raw) > maxLabelBytes || !utf8.ValidString(raw) {
		t.Fatalf("unescaped label is %d bytes (valid UTF-8: %v), want at most %d valid bytes", len(raw), utf8.ValidString(raw), maxLabelBytes)
	}
}

// TestInstanceLabelMatchesWireForm 确认转义后的实例名与 DNS 解包得到的写法一致，
// 服务端据此匹配收到的实例查询。
func TestInstanceLabelMatchesWireForm(t *testing.T) {
	for _, name := range []string{"设计部 Marvis", "Design Mac.mini", `back\slash`, "MacBook-Pro"} {
		fqdn := instanceLabel(name) + "." + ServiceType + "." + Domain

		msg := new(dns.Msg)
		msg.SetQuestion(fqdn, dns.TypeSRV)
		packed, err := msg.Pack()
		if err != nil {
			t.Fatalf("pack question for %q: %v", name, err)
		}

		var parsed dns.Msg
		if err := parsed.Unpack(packed); err != nil {
			t.Fatalf("unpack question for %q: %v", name, err)
		}
		if got := parsed.Question[0].Name; got != fqdn {
			t.Fatalf("question name for %q = %q, want %q", name, got, fqdn)
		}
	}
}

// TestWireTXTRoundTrip 确认 TXT 记录经 DNS 打包、解包、反转义后与原值一致，
// 覆盖中文、反斜杠和引号。
func TestWireTXTRoundTrip(t *testing.T) {
	records := TXTRecords(`设计部 "Marvis" a\b`, "v0.6.5", "7f3a")

	msg := new(dns.Msg)
	msg.Answer = []dns.RR{&dns.TXT{
		Hdr: dns.RR_Header{Name: "x." + ServiceType + "." + Domain, Rrtype: dns.TypeTXT, Class: dns.ClassINET},
		Txt: wireTXT(records),
	}}
	packed, err := msg.Pack()
	if err != nil {
		t.Fatalf("pack TXT: %v", err)
	}

	var parsed dns.Msg
	if err := parsed.Unpack(packed); err != nil {
		t.Fatalf("unpack TXT: %v", err)
	}

	var got []string
	for _, raw := range parsed.Answer[0].(*dns.TXT).Txt {
		got = append(got, unescapeDNS(raw))
	}
	if !reflect.DeepEqual(got, records) {
		t.Fatalf("round trip = %#v, want %#v", got, records)
	}
}

func TestTakenHosts(t *testing.T) {
	entries := []Entry{
		{InstanceID: "self", Host: "marvis.local."},
		{InstanceID: "other-1", Host: "marvis.local."},
		{InstanceID: "other-2", Host: "marvis-2.local."},
		{InstanceID: "other-3", Host: ""},
	}

	got := takenHosts(entries, "self")
	want := []string{"marvis.local.", "marvis-2.local."}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("takenHosts() = %v, want %v", got, want)
	}

	if host := ChooseHostname(got); host != "marvis-3" {
		t.Fatalf("ChooseHostname(%v) = %q, want marvis-3", got, host)
	}
}

func TestLANInterfaces(t *testing.T) {
	ifaces := []net.Interface{
		{Index: 1, Name: "lo0", Flags: net.FlagUp | net.FlagLoopback | net.FlagMulticast},
		{Index: 2, Name: "en0", Flags: net.FlagUp | net.FlagMulticast},
		{Index: 3, Name: "utun3", Flags: net.FlagUp | net.FlagPointToPoint | net.FlagMulticast},
		{Index: 4, Name: "en1", Flags: net.FlagMulticast},
		{Index: 5, Name: "en2", Flags: net.FlagUp | net.FlagMulticast},
	}
	addrs := map[string][]net.Addr{
		"lo0":   {&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}},
		"en0":   {&net.IPNet{IP: net.ParseIP("192.168.1.20"), Mask: net.CIDRMask(24, 32)}, &net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)}},
		"utun3": {&net.IPNet{IP: net.ParseIP("10.8.0.2"), Mask: net.CIDRMask(32, 32)}},
		"en1":   {&net.IPNet{IP: net.ParseIP("192.168.2.9"), Mask: net.CIDRMask(24, 32)}},
		"en2":   {&net.IPAddr{IP: net.ParseIP("10.1.2.3")}, &net.UnixAddr{Name: "ignored"}},
	}

	gotIfaces, gotIPs, err := lanInterfaces(ifaces, func(iface net.Interface) ([]net.Addr, error) {
		return addrs[iface.Name], nil
	})
	if err != nil {
		t.Fatalf("lanInterfaces() error = %v", err)
	}

	var names []string
	for _, iface := range gotIfaces {
		names = append(names, iface.Name)
	}
	if want := []string{"en0", "en2"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("interfaces = %v, want %v", names, want)
	}

	var ips []string
	for _, ip := range gotIPs {
		ips = append(ips, ip.String())
	}
	if want := []string{"192.168.1.20", "10.1.2.3"}; !reflect.DeepEqual(ips, want) {
		t.Fatalf("ips = %v, want %v", ips, want)
	}
}

func TestLANInterfacesPropagatesAddrError(t *testing.T) {
	ifaces := []net.Interface{{Index: 2, Name: "en0", Flags: net.FlagUp}}

	_, _, err := lanInterfaces(ifaces, func(net.Interface) ([]net.Addr, error) {
		return nil, net.ErrClosed
	})
	if err == nil || !strings.Contains(err.Error(), "en0") {
		t.Fatalf("lanInterfaces() error = %v, want an error naming en0", err)
	}
}
