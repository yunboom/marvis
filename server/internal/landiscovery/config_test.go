package landiscovery

import (
	"errors"
	"reflect"
	"testing"
)

// testMiniHost 是测试里使用的电脑名。
const testMiniHost = "mini.local"

// envGetter 把 map 包成 getenv 函数。
func envGetter(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

func TestConfigFromEnv(t *testing.T) {
	host := func() (string, error) { return "design-mac-mini.local", nil }

	cfg := ConfigFromEnv(envGetter(map[string]string{"FRONTEND_PORT": "3100"}), host)
	want := Config{Enabled: true, Name: "design-mac-mini", Port: 3100}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("ConfigFromEnv() = %#v, want %#v", cfg, want)
	}

	cfg = ConfigFromEnv(envGetter(map[string]string{
		"MARVIS_LAN_DISCOVERY": "false",
		"MARVIS_LAN_NAME":      "设计部 Marvis",
	}), host)
	want = Config{Enabled: false, Name: "设计部 Marvis", Port: 3000}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("ConfigFromEnv() = %#v, want %#v", cfg, want)
	}
}

func TestConfigFromEnvFallbacks(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		host func() (string, error)
		want Config
	}{
		{
			name: "hostname lookup fails",
			host: func() (string, error) { return "", errors.New("no hostname") },
			want: Config{Enabled: true, Name: DefaultHostname, Port: DefaultFrontendPort},
		},
		{
			name: "hostname without local suffix and with trailing dot",
			host: func() (string, error) { return "Studio-Mac.LOCAL.", nil },
			want: Config{Enabled: true, Name: "Studio-Mac", Port: DefaultFrontendPort},
		},
		{
			name: "blank custom name falls back to hostname",
			env:  map[string]string{"MARVIS_LAN_NAME": "   "},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: true, Name: "mini", Port: DefaultFrontendPort},
		},
		{
			name: "custom name is trimmed",
			env:  map[string]string{"MARVIS_LAN_NAME": "  设计部  "},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: true, Name: "设计部", Port: DefaultFrontendPort},
		},
		{
			name: "invalid discovery flag keeps advertising",
			env:  map[string]string{"MARVIS_LAN_DISCOVERY": "maybe"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: true, Name: "mini", Port: DefaultFrontendPort},
		},
		{
			name: "invalid port falls back to default",
			env:  map[string]string{"FRONTEND_PORT": "abc"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: true, Name: "mini", Port: DefaultFrontendPort},
		},
		{
			name: "out of range port falls back to default",
			env:  map[string]string{"FRONTEND_PORT": "70000"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: true, Name: "mini", Port: DefaultFrontendPort},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ConfigFromEnv(envGetter(tt.env), tt.host)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("ConfigFromEnv() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestTXTRecords(t *testing.T) {
	got := TXTRecords("设计部 Marvis", "v0.6.5", "7f3a")
	want := []string{"v=1", "name=设计部 Marvis", "ver=v0.6.5", "id=7f3a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TXTRecords() = %#v, want %#v", got, want)
	}
}
