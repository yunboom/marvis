package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// writeDesktopServerFile 在临时配置目录下写入桌面端的 Marvis/server.json。
func writeDesktopServerFile(t *testing.T, configDir, content string) {
	t.Helper()

	dir := filepath.Join(configDir, "Marvis")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create desktop dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "server.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write server.json: %v", err)
	}
}

func TestReadDesktopSelectedServer(t *testing.T) {
	t.Run("reads the fields the desktop app writes", func(t *testing.T) {
		configDir := t.TempDir()
		writeDesktopServerFile(t, configDir, `{
  "url": "http://marvis.local:13840",
  "name": "设计部 Marvis",
  "instanceId": "inst-a",
  "source": "lan",
  "appUrl": "http://marvis.local:3000"
}`)

		got, ok := ReadDesktopSelectedServer(configDir)
		if !ok {
			t.Fatalf("ok: want true")
		}
		want := DesktopServer{URL: "http://marvis.local:13840", Name: "设计部 Marvis", InstanceID: "inst-a"}
		if got != want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("missing file is not selected", func(t *testing.T) {
		if _, ok := ReadDesktopSelectedServer(t.TempDir()); ok {
			t.Fatalf("ok: want false when server.json does not exist")
		}
	})

	t.Run("empty config dir is not selected", func(t *testing.T) {
		if _, ok := ReadDesktopSelectedServer(""); ok {
			t.Fatalf("ok: want false for an empty config dir")
		}
	})

	t.Run("malformed file is ignored", func(t *testing.T) {
		for name, content := range map[string]string{
			"not json":         `{"url": `,
			"wrong field type": `{"url": 42, "name": "x"}`,
			"array":            `["http://marvis.local:13840"]`,
			"empty url":        `{"url": "", "name": "x", "instanceId": "a"}`,
			"missing url":      `{"name": "x", "instanceId": "a"}`,
			"unsupported":      `{"url": "ftp://marvis.local:13840", "name": "x"}`,
			"no host":          `{"url": "http://", "name": "x"}`,
			"not a url":        `{"url": "::::", "name": "x"}`,
		} {
			t.Run(name, func(t *testing.T) {
				configDir := t.TempDir()
				writeDesktopServerFile(t, configDir, content)

				if got, ok := ReadDesktopSelectedServer(configDir); ok {
					t.Fatalf("ok: want false, got %+v", got)
				}
			})
		}
	})

	t.Run("url is normalized to an origin", func(t *testing.T) {
		for raw, want := range map[string]string{
			"http://marvis.local:13840/":               "http://marvis.local:13840",
			"http://Marvis.Local:13840/api/x?y=1#frag": "http://marvis.local:13840",
			"https://user:pw@marvis.example.com/path":  "https://marvis.example.com",
			"http://marvis.example.com:80":             "http://marvis.example.com",
			"https://marvis.example.com:443/":          "https://marvis.example.com",
			"192.168.1.58:13840":                       "http://192.168.1.58:13840",
			"  http://192.168.1.58:13840  ":            "http://192.168.1.58:13840",
			"http://[fe80::1]:13840/":                  "http://[fe80::1]:13840",
		} {
			configDir := t.TempDir()
			writeDesktopServerFile(t, configDir, `{"url": "`+raw+`", "name": "n", "instanceId": "i"}`)

			got, ok := ReadDesktopSelectedServer(configDir)
			if !ok {
				t.Fatalf("url %q: ok want true", raw)
			}
			if got.URL != want {
				t.Fatalf("url %q: got %q, want %q", raw, got.URL, want)
			}
		}
	})
}
