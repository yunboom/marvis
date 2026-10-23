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
		{"discovery disabled", landiscovery.Config{Enabled: false, Name: "studio", Port: 3000}, "7f3a"},
		{"instance id unavailable", landiscovery.Config{Enabled: true, Name: "studio", Port: 3000}, ""},
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
