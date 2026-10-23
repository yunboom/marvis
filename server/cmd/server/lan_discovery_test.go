package main

import (
	"testing"

	"github.com/yunboom/marvis/server/internal/landiscovery"
)

func TestStartLANAdvertisingSkipsWhenNotApplicable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		cfg        landiscovery.Config
		instanceID string
	}{
		{"discovery disabled", landiscovery.Config{Enabled: false, Name: "studio", Port: 13840}, "7f3a"},
		{"instance id unavailable", landiscovery.Config{Enabled: true, Name: "studio", Port: 13840}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			lan := startLANAdvertising(tc.cfg, "v0.6.5", tc.instanceID, &landiscovery.Status{})
			if lan != nil {
				lan.Stop()
				t.Fatal("startLANAdvertising() started advertising, want nil")
			}

			// nil 值的 Stop 必须安全，main 在关闭路径上无条件调用。
			lan.Stop()
		})
	}
}

func TestLANConfigForListenPort(t *testing.T) {
	t.Parallel()

	base := landiscovery.Config{Enabled: true, Name: "studio", Port: landiscovery.DefaultServerPort}
	tests := []struct {
		name string
		port string
		want int
	}{
		{"listen port overrides the config", "13900", 13900},
		{"default listen port", "13840", 13840},
		{"unparsable listen port keeps the config value", "abc", landiscovery.DefaultServerPort},
		{"empty listen port keeps the config value", "", landiscovery.DefaultServerPort},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := lanConfigForListenPort(base, tc.port)
			if got.Port != tc.want || got.Name != base.Name || got.Enabled != base.Enabled {
				t.Fatalf("lanConfigForListenPort(%q) = %#v, want port %d and the other fields unchanged", tc.port, got, tc.want)
			}
		})
	}
}

// 只监听本机地址时局域网里的设备连不上，广播出去也没用，所以关闭广播。
func TestLANConfigForListenHost(t *testing.T) {
	t.Parallel()

	base := landiscovery.Config{Enabled: true, Name: "studio", Port: landiscovery.DefaultServerPort}
	tests := []struct {
		host string
		want bool
	}{
		{"", true},
		{"0.0.0.0", true},
		{"192.168.1.20", true},
		{"127.0.0.1", false},
		{"::1", false},
		{"localhost", false},
		{" LocalHost ", false},
	}
	for _, tc := range tests {
		if got := lanConfigForListenHost(base, tc.host); got.Enabled != tc.want || got.Name != base.Name || got.Port != base.Port {
			t.Errorf("lanConfigForListenHost(%q) = %#v, want Enabled=%v and the other fields unchanged", tc.host, got, tc.want)
		}
	}

	off := base
	off.Enabled = false
	if got := lanConfigForListenHost(off, ""); got.Enabled {
		t.Errorf("lanConfigForListenHost turned a disabled config on = %#v", got)
	}
}
