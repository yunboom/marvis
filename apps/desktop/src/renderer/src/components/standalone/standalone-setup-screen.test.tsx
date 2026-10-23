import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  isIntegrationKey,
  type StandaloneSetupInput,
  type StandaloneSubmitResult,
} from "../../../../shared/standalone";
import { StandaloneSetupForm } from "./standalone-setup-form";
import { StandaloneSetupScreen } from "./standalone-setup-screen";

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  defaults: vi.fn(),
}));

function setupInput(overrides: { adminEmail?: string; vcsKey?: string } = {}): StandaloneSetupInput {
  const secrets = generateStandaloneSecrets();
  if (overrides.vcsKey !== undefined) secrets.integrationKeys.MARVIS_VCS_SECRET_KEY = overrides.vcsKey;

  return {
    settings: { ...defaultStandaloneSettings("mac-mini"), adminEmail: overrides.adminEmail ?? "" },
    secrets,
  };
}

// 与连接页一样由父组件持有表单值。
function Harness({ initial, onStarted = () => {} }: { initial: StandaloneSetupInput; onStarted?: () => void }) {
  const [value, setValue] = useState<StandaloneSetupInput | null>(initial);

  return <StandaloneSetupScreen value={value} onChange={setValue} onBack={() => {}} onStarted={onStarted} />;
}

function renderWithI18n(ui: React.ReactElement) {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      {ui}
    </I18nProvider>,
  );
}

function groupButton(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  mocks.install.mockReset().mockResolvedValue({ ok: true } satisfies StandaloneSubmitResult);
  mocks.defaults.mockReset();

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      appInfo: { os: "macos", version: "0.6.5" },
      standalone: { install: mocks.install, defaults: mocks.defaults },
    },
  });
});

describe("StandaloneSetupScreen", () => {
  it("blocks download until the admin email is filled", () => {
    renderWithI18n(<Harness initial={setupInput()} />);

    expect(screen.getByRole("button", { name: "下载资源" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("1 项配置需要修改");
    // 没填之前不标红，失焦后才提示。
    expect(screen.queryByText("请填写管理员邮箱")).not.toBeInTheDocument();

    fireEvent.blur(screen.getByLabelText("管理员邮箱"));
    expect(screen.getByText("请填写管理员邮箱")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("管理员邮箱"), { target: { value: "me@example.com" } });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载资源" })).toBeEnabled();
  });

  it("expands the security keys row when an integration key is invalid", () => {
    renderWithI18n(<Harness initial={setupInput({ adminEmail: "me@example.com", vcsKey: "my-vcs-key" })} />);

    const keysRow = groupButton(/安全密钥/);
    expect(keysRow).toHaveAttribute("aria-expanded", "true");
    expect(keysRow).toHaveTextContent("1 项需要修改");
    expect(screen.getByText("需要 base64 编码的 32 字节密钥")).toBeInTheDocument();
    expect(screen.getByLabelText("代码仓库凭证加密密钥")).toHaveAttribute("aria-invalid", "true");
    // 其他分组保持收起。
    expect(groupButton(/常规/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "下载资源" })).toBeDisabled();
  });

  it("fills a valid value with the random buttons", () => {
    renderWithI18n(<Harness initial={setupInput({ adminEmail: "me@example.com", vcsKey: "my-vcs-key" })} />);

    fireEvent.click(screen.getByRole("button", { name: "随机生成代码仓库凭证加密密钥" }));

    const key = screen.getByLabelText("代码仓库凭证加密密钥") as HTMLInputElement;
    expect(isIntegrationKey(key.value)).toBe(true);
    expect(screen.queryByText("需要 base64 编码的 32 字节密钥")).not.toBeInTheDocument();

    fireEvent.click(groupButton(/登录验证码/));
    const code = screen.getByLabelText("登录验证码") as HTMLInputElement;
    expect(code.value).toBe("888888");

    fireEvent.change(code, { target: { value: "12" } });
    expect(screen.getByText("需要 6 位数字")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "随机生成登录验证码" }));
    expect((screen.getByLabelText("登录验证码") as HTMLInputElement).value).toMatch(/^\d{6}$/);
    expect(screen.queryByText("需要 6 位数字")).not.toBeInTheDocument();
  });

  it("warns about LAN login only when no member login method is set up", () => {
    const warning = "局域网登录需要配置登录验证码、飞书登录或邮件服务中的一种";
    renderWithI18n(<Harness initial={setupInput({ adminEmail: "me@example.com" })} />);

    fireEvent.click(groupButton(/常规/));
    fireEvent.click(screen.getByRole("switch", { name: "允许局域网连接" }));
    expect(screen.getByText("本机和局域网")).toBeInTheDocument();
    // 固定验证码默认开启。
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    fireEvent.click(groupButton(/登录验证码/));
    fireEvent.click(screen.getByRole("switch", { name: "启用固定验证码" }));
    expect(screen.getByText(warning)).toBeInTheDocument();

    fireEvent.click(groupButton(/飞书登录/));
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "cli_abc" } });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "" } });
    fireEvent.click(groupButton(/邮件服务/));
    fireEvent.change(screen.getByLabelText("发信地址"), { target: { value: "smtp.example.com" } });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it("shows the errors returned by install next to their fields", async () => {
    mocks.install.mockResolvedValueOnce({
      ok: false,
      errors: { "settings.port": "port_range" },
    } satisfies StandaloneSubmitResult);
    const onStarted = vi.fn();
    renderWithI18n(<Harness initial={setupInput({ adminEmail: "me@example.com" })} onStarted={onStarted} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下载资源" }));
    });

    expect(mocks.install).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    expect(groupButton(/常规/)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("端口范围 1024–65535")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 项配置需要修改");
  });

  it("moves on once install accepts the settings", async () => {
    const onStarted = vi.fn();
    const input = setupInput({ adminEmail: "me@example.com" });
    renderWithI18n(<Harness initial={input} onStarted={onStarted} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下载资源" }));
    });

    expect(mocks.install).toHaveBeenCalledWith(input);
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("loads the defaults when there is no value yet", async () => {
    const input = setupInput();
    mocks.defaults.mockResolvedValueOnce(input);
    renderWithI18n(<Harness initial={null as unknown as StandaloneSetupInput} />);

    expect(await screen.findByLabelText("管理员邮箱")).toBeInTheDocument();
    expect(mocks.defaults).toHaveBeenCalledOnce();
  });
});

describe("StandaloneSetupForm", () => {
  it("pins the field help open on click and closes it on a second click", async () => {
    const help = "第一个账号，也是工作区所有者。Marvis 用它在这台电脑上自动登录。";
    renderWithI18n(<StandaloneSetupForm value={setupInput()} onChange={() => {}} errors={{}} />);

    const info = screen.getByRole("button", { name: "管理员邮箱说明" });
    fireEvent.click(info);

    expect(await screen.findByText(help)).toBeInTheDocument();
    expect(info).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("makes the signing and integration keys read-only when locked", () => {
    renderWithI18n(
      <StandaloneSetupForm value={setupInput({ adminEmail: "me@example.com" })} onChange={() => {}} errors={{}} locked />,
    );

    const keysRow = groupButton(/安全密钥/);
    expect(keysRow).toHaveTextContent("已锁定，不能修改");
    fireEvent.click(keysRow);

    const keys = within(keysRow.parentElement!);
    expect(keys.getByLabelText("登录签名密钥")).toHaveAttribute("readonly");
    expect(keys.getByLabelText("飞书凭证加密密钥")).toHaveAttribute("readonly");
    expect(keys.queryByRole("button", { name: /^随机生成/ })).not.toBeInTheDocument();
  });
});
