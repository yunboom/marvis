package landiscovery

import (
	"net"
	"reflect"
	"testing"
)

func TestAdvertiseIPs(t *testing.T) {
	ifaces := []Iface{
		{Name: "lo0", Up: true, Loopback: true, Addrs: []net.IP{net.ParseIP("127.0.0.1")}},
		{Name: "en0", Up: true, Addrs: []net.IP{net.ParseIP("192.168.1.20"), net.ParseIP("fe80::1")}},
		{Name: "utun3", Up: true, PointToPoint: true, Addrs: []net.IP{net.ParseIP("10.8.0.2")}},
		{Name: "en7", Up: false, Addrs: []net.IP{net.ParseIP("192.168.2.9")}},
		{Name: "en1", Up: true, Addrs: []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("169.254.3.3")}},
	}

	got := AdvertiseIPs(ifaces)
	want := []net.IP{net.ParseIP("192.168.1.20")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AdvertiseIPs() = %v, want %v", got, want)
	}
}

func TestAdvertiseIPsKeepsInterfaceOrder(t *testing.T) {
	ifaces := []Iface{
		{Name: "en0", Up: true, Addrs: []net.IP{net.ParseIP("192.168.1.20")}},
		{Name: "en1", Up: true, Addrs: []net.IP{net.IPv4(10, 0, 0, 5).To4(), net.ParseIP("172.16.0.9")}},
	}

	var got []string
	for _, ip := range AdvertiseIPs(ifaces) {
		got = append(got, ip.String())
	}
	want := []string{"192.168.1.20", "10.0.0.5", "172.16.0.9"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AdvertiseIPs() = %v, want %v", got, want)
	}
}

func TestAdvertiseIPsEmpty(t *testing.T) {
	if got := AdvertiseIPs(nil); len(got) != 0 {
		t.Fatalf("AdvertiseIPs(nil) = %v, want empty", got)
	}
}

func TestChooseHostname(t *testing.T) {
	tests := []struct {
		name  string
		taken []string
		want  string
	}{
		{name: "nothing taken", taken: nil, want: "marvis"},
		{name: "base taken", taken: []string{"marvis.local."}, want: "marvis-2"},
		{name: "case and suffix ignored", taken: []string{"marvis.local.", "Marvis-2.local."}, want: "marvis-3"},
		{name: "unrelated hosts", taken: []string{"printer.local.", "nas"}, want: "marvis"},
		{name: "gap is reused", taken: []string{"marvis", "marvis-3"}, want: "marvis-2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ChooseHostname(tt.taken); got != tt.want {
				t.Fatalf("ChooseHostname(%v) = %q, want %q", tt.taken, got, tt.want)
			}
		})
	}
}
