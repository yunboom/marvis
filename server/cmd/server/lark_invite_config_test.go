package main

import (
	"context"
	"errors"
	"testing"

	"github.com/yunboom/marvis/server/internal/handler"
	"github.com/yunboom/marvis/server/internal/integrations/lark"
	"github.com/yunboom/marvis/server/internal/seatcapacity"
)

const (
	testLarkLoginAppIDEnv     = "MARVIS_LARK_LOGIN_APP_ID"
	testLarkLoginAppSecretEnv = "MARVIS_LARK_LOGIN_APP_SECRET"
	testLarkInviteAppID       = "cli_invite_app"
	testLarkInviteAppSecret   = "invite-app-secret"
	testDesktopDownloadURL    = "https://example.com/download"
)

// setLarkInviteEnv 一次性设置飞书邀请相关的全部环境变量，空串等同于未设置。
func setLarkInviteEnv(t *testing.T, enabled, appID, appSecret, downloadURL string) {
	t.Helper()

	t.Setenv(larkInviteEnabledEnv, enabled)
	t.Setenv(testLarkLoginAppIDEnv, appID)
	t.Setenv(testLarkLoginAppSecretEnv, appSecret)
	t.Setenv(desktopDownloadURLEnv, downloadURL)
}

// assertLarkInviteOff 断言飞书邀请的四个字段都保持零值。
func assertLarkInviteOff(t *testing.T, h *handler.Handler) {
	t.Helper()

	if h.LarkInviteAPI != nil {
		t.Error("LarkInviteAPI should stay nil")
	}
	if h.LarkInviteConn != nil {
		t.Error("LarkInviteConn should stay nil")
	}
	if h.LarkInviteCreds != (lark.InstallationCredentials{}) {
		t.Errorf("LarkInviteCreds should stay zero, got %+v", h.LarkInviteCreds)
	}
	if h.LarkInviteDownloadURL != "" {
		t.Errorf("LarkInviteDownloadURL should stay empty, got %q", h.LarkInviteDownloadURL)
	}
}

func TestLarkInviteEnabled(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "unset", value: "", want: false},
		{name: "false", value: "false", want: false},
		{name: "zero", value: "0", want: false},
		{name: "unknown word", value: "on", want: false},
		{name: "upper TRUE", value: "TRUE", want: true},
		{name: "lower true", value: "true", want: true},
		{name: "one", value: "1", want: true},
		{name: "yes", value: "yes", want: true},
		{name: "mixed case Yes", value: "Yes", want: true},
		{name: "surrounding spaces", value: "  true  ", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(larkInviteEnabledEnv, tt.value)

			if got := larkInviteEnabled(); got != tt.want {
				t.Errorf("larkInviteEnabled() with %q = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestConfigureLarkInvite(t *testing.T) {
	t.Run("switch off", func(t *testing.T) {
		setLarkInviteEnv(t, "", testLarkInviteAppID, testLarkInviteAppSecret, testDesktopDownloadURL)

		h := &handler.Handler{}
		configureLarkInvite(h)

		assertLarkInviteOff(t, h)
	})

	t.Run("switch explicitly false", func(t *testing.T) {
		setLarkInviteEnv(t, "false", testLarkInviteAppID, testLarkInviteAppSecret, testDesktopDownloadURL)

		h := &handler.Handler{}
		configureLarkInvite(h)

		assertLarkInviteOff(t, h)
	})

	t.Run("missing app id", func(t *testing.T) {
		setLarkInviteEnv(t, "true", "", testLarkInviteAppSecret, testDesktopDownloadURL)

		h := &handler.Handler{}
		configureLarkInvite(h)

		assertLarkInviteOff(t, h)
	})

	t.Run("missing app secret", func(t *testing.T) {
		setLarkInviteEnv(t, "true", testLarkInviteAppID, "", testDesktopDownloadURL)

		h := &handler.Handler{}
		configureLarkInvite(h)

		assertLarkInviteOff(t, h)
	})

	t.Run("seat capacity enabled", func(t *testing.T) {
		setLarkInviteEnv(t, "true", testLarkInviteAppID, testLarkInviteAppSecret, testDesktopDownloadURL)

		h := &handler.Handler{SeatCapacity: seatcapacity.NewUnavailable(errors.New("cloud url malformed"))}
		configureLarkInvite(h)

		assertLarkInviteOff(t, h)
	})

	t.Run("all conditions met", func(t *testing.T) {
		setLarkInviteEnv(t, "true", testLarkInviteAppID, testLarkInviteAppSecret, testDesktopDownloadURL)

		h := &handler.Handler{}
		configureLarkInvite(h)

		if h.LarkInviteAPI == nil {
			t.Error("LarkInviteAPI should be set")
		}
		if h.LarkInviteConn == nil {
			t.Error("LarkInviteConn should be set")
		}

		wantCreds := lark.InstallationCredentials{
			AppID:     testLarkInviteAppID,
			AppSecret: testLarkInviteAppSecret,
			Region:    lark.RegionFeishu,
		}
		if h.LarkInviteCreds != wantCreds {
			t.Errorf("LarkInviteCreds = %+v, want %+v", h.LarkInviteCreds, wantCreds)
		}
		if h.LarkInviteDownloadURL != testDesktopDownloadURL {
			t.Errorf("LarkInviteDownloadURL = %q, want %q", h.LarkInviteDownloadURL, testDesktopDownloadURL)
		}
	})

	t.Run("download url optional and trimmed", func(t *testing.T) {
		setLarkInviteEnv(t, "yes", testLarkInviteAppID, testLarkInviteAppSecret, "  ")

		h := &handler.Handler{}
		configureLarkInvite(h)

		if h.LarkInviteAPI == nil || h.LarkInviteConn == nil {
			t.Fatal("feature should be on without a download url")
		}
		if h.LarkInviteDownloadURL != "" {
			t.Errorf("LarkInviteDownloadURL = %q, want empty", h.LarkInviteDownloadURL)
		}
	})
}

// TestLarkInviteConnectorConfigWiresCardHandler 确认邀请长连接把卡片回调交给 HandleLarkInviteCardAction：
// 少了 CardHandler 时点击回调会被当成普通事件丢弃，整条加入链路不会触发。
func TestLarkInviteConnectorConfigWiresCardHandler(t *testing.T) {
	creds := lark.InstallationCredentials{AppID: testLarkInviteAppID, AppSecret: testLarkInviteAppSecret, Region: lark.RegionFeishu}
	fetcher := lark.EndpointFetcherFunc(func(context.Context, lark.InstallationCredentials) (lark.WSEndpoint, error) {
		return lark.WSEndpoint{}, nil
	})

	cfg := larkInviteConnectorConfig(&handler.Handler{}, creds, fetcher, lark.NewGorillaDialer())

	if cfg.CardHandler == nil {
		t.Fatal("invite connector has no CardHandler; card clicks would be dropped")
	}

	// 不是“加入工作区”按钮的回调，邀请处理函数回空回应 {}：据此确认接上的正是它。
	resp, err := cfg.CardHandler(context.Background(), []byte(`{"event":{"action":{"value":{"action":"other"}}}}`))
	if err != nil || string(resp) != "{}" {
		t.Fatalf("CardHandler response = %s, %v; want {} from HandleLarkInviteCardAction", resp, err)
	}

	if _, ok, err := cfg.FrameDecoder.Decode([]byte(`{"schema":"2.0","header":{"event_type":"im.message.receive_v1"},"event":{}}`), lark.Installation{}); ok || err != nil {
		t.Fatalf("invite connector decoded a message event (ok=%v err=%v); events must be dropped", ok, err)
	}

	gotCreds, err := cfg.CredentialsProvider.Credentials(context.Background(), lark.Installation{})
	if err != nil || gotCreds != creds {
		t.Fatalf("credentials = %+v, %v; want the login app %+v", gotCreds, err, creds)
	}
}
