package landiscovery

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// testMiniHost 是测试里使用的电脑名。
const testMiniHost = "mini.local"

// envGetter 把 map 包成 getenv 函数。
func envGetter(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

func TestConfigFromEnv(t *testing.T) {
	host := func() (string, error) { return "design-mac-mini.local", nil }

	// 未设置 MARVIS_LAN_DISCOVERY 时默认不广播。
	cfg := ConfigFromEnv(envGetter(map[string]string{"PORT": "13900"}), host)
	want := Config{Enabled: false, Name: "design-mac-mini", Port: 13900}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("ConfigFromEnv() = %#v, want %#v", cfg, want)
	}

	cfg = ConfigFromEnv(envGetter(map[string]string{"MARVIS_LAN_DISCOVERY": "true"}), host)
	want = Config{Enabled: true, Name: "design-mac-mini", Port: 13840}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("ConfigFromEnv() = %#v, want %#v", cfg, want)
	}

	cfg = ConfigFromEnv(envGetter(map[string]string{
		"MARVIS_LAN_DISCOVERY": "false",
		"MARVIS_LAN_NAME":      "设计部 Marvis",
	}), host)
	want = Config{Enabled: false, Name: "设计部 Marvis", Port: 13840}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("ConfigFromEnv() = %#v, want %#v", cfg, want)
	}
}

func TestDefaultServerPort(t *testing.T) {
	// 与 cmd/server 的默认监听端口保持一致。
	if DefaultServerPort != 13840 {
		t.Fatalf("DefaultServerPort = %d, want 13840", DefaultServerPort)
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
			want: Config{Enabled: false, Name: DefaultHostname, Port: DefaultServerPort},
		},
		{
			name: "hostname without local suffix and with trailing dot",
			host: func() (string, error) { return "Studio-Mac.LOCAL.", nil },
			want: Config{Enabled: false, Name: "Studio-Mac", Port: DefaultServerPort},
		},
		{
			name: "blank custom name falls back to hostname",
			env:  map[string]string{"MARVIS_LAN_NAME": "   "},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "mini", Port: DefaultServerPort},
		},
		{
			name: "custom name is trimmed",
			env:  map[string]string{"MARVIS_LAN_NAME": "  设计部  "},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "设计部", Port: DefaultServerPort},
		},
		{
			name: "invalid discovery flag stays off",
			env:  map[string]string{"MARVIS_LAN_DISCOVERY": "maybe"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "mini", Port: DefaultServerPort},
		},
		{
			name: "invalid port falls back to default",
			env:  map[string]string{"PORT": "abc"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "mini", Port: DefaultServerPort},
		},
		{
			name: "web port variable is ignored",
			env:  map[string]string{"FRONTEND_PORT": "3100"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "mini", Port: DefaultServerPort},
		},
		{
			name: "out of range port falls back to default",
			env:  map[string]string{"PORT": "70000"},
			host: func() (string, error) { return testMiniHost, nil },
			want: Config{Enabled: false, Name: "mini", Port: DefaultServerPort},
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

func TestTXTRecordsTruncatesNameAtRuneBoundary(t *testing.T) {
	// 每个汉字 3 字节，100 个汉字共 300 字节，超过单条 TXT 记录的 255 字节上限。
	name := strings.Repeat("设", 100)

	records := TXTRecords(name, "v0.6.5", "7f3a")
	got := records[1]
	if len(got) > maxTXTStringBytes {
		t.Fatalf("name record is %d bytes, want at most %d", len(got), maxTXTStringBytes)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("name record %q is not valid UTF-8 after truncation", got)
	}

	// name= 占 5 字节，剩余 250 字节最多容纳 83 个汉字（249 字节）。
	if want := "name=" + strings.Repeat("设", 83); got != want {
		t.Fatalf("name record = %q, want %q", got, want)
	}

	// 其他记录不受影响。
	if want := []string{"v=1", "ver=v0.6.5", "id=7f3a"}; !reflect.DeepEqual([]string{records[0], records[2], records[3]}, want) {
		t.Fatalf("other records = %#v, want %#v", []string{records[0], records[2], records[3]}, want)
	}
}

func TestTXTRecordsKeepsNameThatFits(t *testing.T) {
	// 恰好 250 字节的值加上 name= 正好 255 字节，不截断。
	exact := strings.Repeat("a", maxTXTStringBytes-len("name="))
	if got := TXTRecords(exact, "", "")[1]; got != "name="+exact {
		t.Fatalf("name record was changed: got %d bytes, want %d", len(got), len("name=")+len(exact))
	}

	// 多一个字节则截断回 250 字节。
	if got := TXTRecords(exact+"b", "", "")[1]; got != "name="+exact {
		t.Fatalf("name record = %d bytes, want %d", len(got), len("name=")+len(exact))
	}
}
