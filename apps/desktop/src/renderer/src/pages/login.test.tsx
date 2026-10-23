import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const config = vi.hoisted(() => ({ larkLoginAppId: "" }));

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

function setAppUrl(appUrl: string) {
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      runtimeConfig: { ok: true, config: { appUrl } },
      openExternal,
    },
  });
}

beforeEach(() => {
  openExternal.mockReset();
  config.larkLoginAppId = "cli_lark";
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
  });

  describe("without a web app", () => {
    beforeEach(() => setAppUrl(""));

    it("leaves only email-code login", () => {
      render(<DesktopLoginPage />);

      expect(screen.getByText("email-code")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "google" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "lark" })).not.toBeInTheDocument();
    });
  });
});
