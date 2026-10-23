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
			lan := startLANAdvertising(tc.cfg, "v0.6.5", tc.instanceID)
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
