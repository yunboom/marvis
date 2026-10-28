import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import { DesktopAuthRecoveryPage } from "./auth-recovery";

const mocks = vi.hoisted(() => ({
  retryAuthentication: vi.fn(),
  logoutBeforeSwitch: vi.fn(async () => {}),
}));

vi.mock("@marvis/core/auth", () => {
  const state = { retryAuthentication: mocks.retryAuthentication };
  const useAuthStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useAuthStore };
});

vi.mock("../components/server/use-logout-before-switch", () => ({
  useLogoutBeforeSwitch: () => mocks.logoutBeforeSwitch,
}));

// 连接页本身由 connect-server-screen.test.tsx 覆盖，这里只看恢复页怎么把它接进来。
vi.mock("../components/server/connect-server-screen", () => ({
  ConnectServerScreen: ({
    beforeSwitch,
    onBack,
  }: {
    beforeSwitch?: () => Promise<void>;
    onBack?: () => void;
  }) => (
    <div>
      <p>connect-server-screen</p>
      <button type="button" onClick={() => void beforeSwitch?.()}>
        switch
      </button>
      <button type="button" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));

function renderPage(props: Parameters<typeof DesktopAuthRecoveryPage>[0] = {}) {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      <DesktopAuthRecoveryPage {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.retryAuthentication.mockReset();
  mocks.logoutBeforeSwitch.mockClear();
});

describe("DesktopAuthRecoveryPage", () => {
  it("only retries where switching servers is not offered", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换服务器" })).not.toBeInTheDocument();
  });

  it("opens the server picker, signing out of the old server before a switch", () => {
    renderPage({ canSwitchServer: true });

    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));
    expect(screen.getByText("connect-server-screen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(mocks.logoutBeforeSwitch).toHaveBeenCalledOnce();
  });

  it("returns to the recovery page from the picker", () => {
    renderPage({ canSwitchServer: true });

    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));
    fireEvent.click(screen.getByRole("button", { name: "back" }));

    expect(screen.getByRole("heading", { name: "正在重新连接 Marvis" })).toBeInTheDocument();
    expect(mocks.logoutBeforeSwitch).not.toHaveBeenCalled();
  });
});
