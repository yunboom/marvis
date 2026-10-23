import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  SERVER_STATE_RECONNECTING,
  SERVER_STATE_UNREACHABLE,
} from "../../../../shared/server-discovery";
import { ServerReplacedDialog, ServerStatusBanner } from "./server-status-banner";

function withI18n(node: React.ReactNode) {
  return (
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      {node}
    </I18nProvider>
  );
}

const server = { name: "设计部 Marvis", address: "marvis.local:13840" };

describe("ServerStatusBanner", () => {
  it("shows a spinner and the reconnecting copy without actions", () => {
    const { container } = render(
      withI18n(
        <ServerStatusBanner
          state={SERVER_STATE_RECONNECTING}
          server={server}
          onRetry={vi.fn()}
          onSwitch={vi.fn()}
        />,
      ),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "与 设计部 Marvis 的连接已断开，正在重新连接…",
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the unreachable copy with retry and switch actions", () => {
    const onRetry = vi.fn();
    const onSwitch = vi.fn();
    const { container } = render(
      withI18n(
        <ServerStatusBanner
          state={SERVER_STATE_UNREACHABLE}
          server={server}
          onRetry={onRetry}
          onSwitch={onSwitch}
        />,
      ),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "无法连接到 设计部 Marvis（marvis.local:13840）。页面内容可能不是最新的。",
    );
    expect(container.querySelector(".animate-spin")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("tints the reconnecting banner as a warning and the unreachable one as an error", () => {
    const { rerender } = render(
      withI18n(
        <ServerStatusBanner
          state={SERVER_STATE_RECONNECTING}
          server={server}
          onRetry={vi.fn()}
          onSwitch={vi.fn()}
        />,
      ),
    );
    expect(screen.getByRole("status").className).toContain("bg-warning");

    rerender(
      withI18n(
        <ServerStatusBanner
          state={SERVER_STATE_UNREACHABLE}
          server={server}
          onRetry={vi.fn()}
          onSwitch={vi.fn()}
        />,
      ),
    );
    expect(screen.getByRole("status").className).toContain("bg-destructive");
  });
});

describe("ServerReplacedDialog", () => {
  function renderDialog(open: boolean, handlers = { onWait: vi.fn(), onSwitch: vi.fn() }) {
    render(
      withI18n(
        <ServerReplacedDialog
          open={open}
          server={server}
          otherName="测试环境"
          onWait={handlers.onWait}
          onSwitch={handlers.onSwitch}
        />,
      ),
    );

    return handlers;
  }

  it("explains which server answers at the saved address and that nothing was switched", () => {
    renderDialog(true);

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("这个地址上换了一台服务器");
    expect(dialog).toHaveTextContent(
      "marvis.local:13840 现在是“测试环境”，不是你之前连接的“设计部 Marvis”。为避免连错，没有自动切换。",
    );
  });

  it("keeps waiting from the secondary button", () => {
    const { onWait, onSwitch } = renderDialog(true);

    fireEvent.click(screen.getByRole("button", { name: "继续等待" }));

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("opens the server settings from the primary button", () => {
    const { onWait, onSwitch } = renderDialog(true);

    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("treats Escape as continuing to wait", () => {
    const { onWait } = renderDialog(true);

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    renderDialog(false);

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
