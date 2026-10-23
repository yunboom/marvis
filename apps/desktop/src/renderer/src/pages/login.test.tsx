import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const config = vi.hoisted(() => ({ larkLoginAppId: "", larkDesktopLogin: false }));

vi.mock("@marvis/core/config", () => ({
  useConfigStore: (selector: (state: typeof config) => unknown) =>
    selector(config),
}));

vi.mock("@marvis/views/platform", () => ({ DragStrip: () => null }));

vi.mock("@marvis/ui/components/common/marvis-icon", () => ({
  MarvisIcon: () => null,
}));

// 真实 LoginPage 里「有处理函数才渲染按钮」，这里只关心桌面端传了哪些处理函数。
vi.mock("@marvis/views/auth", () => ({
  LoginPage: ({
    onGoogleLogin,
    onLarkLogin,
  }: {
    onGoogleLogin?: () => void;
    onLarkLogin?: () => void;
  }) => (
    <div>
      {onGoogleLogin && (
        <button type="button" onClick={onGoogleLogin}>
          google
        </button>
      )}
      {onLarkLogin && (
        <button type="button" onClick={onLarkLogin}>
          lark
        </button>
      )}
      <span>email-code</span>
    </div>
  ),
}));

import { DesktopLoginPage } from "./login";

const openExternal = vi.fn();
const startLarkDesktopLogin = vi.fn().mockResolvedValue(undefined);

function setAppUrl(appUrl: string) {
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      runtimeConfig: { ok: true, config: { appUrl } },
      openExternal,
      startLarkDesktopLogin,
    },
  });
}

beforeEach(() => {
  openExternal.mockReset();
  startLarkDesktopLogin.mockClear();
  config.larkLoginAppId = "cli_lark";
  config.larkDesktopLogin = false;
});

describe("DesktopLoginPage", () => {
  describe("with a web app", () => {
    beforeEach(() => setAppUrl("https://app.example"));

    it("shows Google and Feishu login", () => {
      render(<DesktopLoginPage />);

      expect(screen.getByRole("button", { name: "google" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "lark" })).toBeInTheDocument();
    });

    it("hides Feishu login when it is not configured", () => {
      config.larkLoginAppId = "";

      render(<DesktopLoginPage />);

      expect(screen.getByRole("button", { name: "google" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "lark" })).not.toBeInTheDocument();
    });

    it("opens the web login page in the browser", () => {
      render(<DesktopLoginPage />);

      fireEvent.click(screen.getByRole("button", { name: "google" }));

      expect(openExternal).toHaveBeenCalledWith(
        "https://app.example/login?platform=desktop",
      );
    });

    it("keeps Feishu login on the web login page even when the server can host it", () => {
      config.larkDesktopLogin = true;

      render(<DesktopLoginPage />);
      fireEvent.click(screen.getByRole("button", { name: "lark" }));

      expect(openExternal).toHaveBeenCalledWith(
        "https://app.example/login?platform=desktop",
      );
      expect(startLarkDesktopLogin).not.toHaveBeenCalled();
    });
  });

  describe("without a web app", () => {
    beforeEach(() => setAppUrl(""));

    it("leaves only email-code login", () => {
      render(<DesktopLoginPage />);

      expect(screen.getByText("email-code")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "google" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "lark" })).not.toBeInTheDocument();
    });

    it("shows Feishu login when the server hosts the Feishu callback", () => {
      config.larkDesktopLogin = true;

      render(<DesktopLoginPage />);

      expect(screen.getByRole("button", { name: "lark" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "google" })).not.toBeInTheDocument();
    });

    it("starts Feishu login through the main process", () => {
      config.larkDesktopLogin = true;

      render(<DesktopLoginPage />);
      fireEvent.click(screen.getByRole("button", { name: "lark" }));

      expect(startLarkDesktopLogin).toHaveBeenCalledTimes(1);
      expect(openExternal).not.toHaveBeenCalled();
    });
  });
});
