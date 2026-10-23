import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { LarkInviteWelcome as WelcomeRecord } from "@marvis/core/types";
import { workspaceKeys } from "@marvis/core/workspace/queries";
import { renderWithI18n } from "../test/i18n";

const mockApi = vi.hoisted(() => ({
  getLarkInviteWelcome: vi.fn(),
  ackLarkInviteWelcome: vi.fn(),
}));

vi.mock("@marvis/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/api")>()),
  api: mockApi,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { LarkInviteWelcome } from "./lark-invite-welcome";

const welcome = (role: WelcomeRecord["role"] = "member"): WelcomeRecord => ({
  invite_id: "inv-1",
  inviter_name: "Ada",
  role,
});

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mount(
  props: { wsId: string; workspaceName: string },
  client = makeClient(),
  locale?: "zh-Hans",
) {
  const tree = (p: { wsId: string; workspaceName: string }) => (
    <QueryClientProvider client={client}>
      <LarkInviteWelcome {...p} />
    </QueryClientProvider>
  );
  const view = renderWithI18n(tree(props), { locale });

  return {
    client,
    rerender: (next: { wsId: string; workspaceName: string }) => view.rerender(tree(next)),
  };
}

describe("LarkInviteWelcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.ackLarkInviteWelcome.mockResolvedValue(undefined);
  });

  it("shows a toast with the workspace, inviter and role, then acks once", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(welcome("member"));

    mount({ wsId: "ws-1", workspaceName: "Acme" });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Joined Acme", {
      description: "Joined through Ada’s Feishu invite as Member.",
    });
    await waitFor(() => expect(mockApi.ackLarkInviteWelcome).toHaveBeenCalledTimes(1));
    expect(mockApi.getLarkInviteWelcome).toHaveBeenCalledWith("ws-1");
    expect(mockApi.ackLarkInviteWelcome).toHaveBeenCalledWith("ws-1");
  });

  it("uses the localized copy and the admin role label", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(welcome("admin"));

    mount({ wsId: "ws-1", workspaceName: "Acme" }, makeClient(), "zh-Hans");

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("已加入 Acme", {
      description: "通过Ada的飞书邀请，角色为管理员。",
    });
  });

  it("shows nothing and does not ack when there is no pending welcome", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(null);

    mount({ wsId: "ws-1", workspaceName: "Acme" });

    await waitFor(() => expect(mockApi.getLarkInviteWelcome).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockApi.ackLarkInviteWelcome).not.toHaveBeenCalled();
  });

  it("shows nothing when the request fails", async () => {
    mockApi.getLarkInviteWelcome.mockRejectedValue(new Error("boom"));

    mount({ wsId: "ws-1", workspaceName: "Acme" });

    await waitFor(() => expect(mockApi.getLarkInviteWelcome).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(mockApi.ackLarkInviteWelcome).not.toHaveBeenCalled();
  });

  it("does not show the toast again when the same workspace re-renders", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(welcome());

    const { rerender } = mount({ wsId: "ws-1", workspaceName: "Acme" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockApi.ackLarkInviteWelcome).toHaveBeenCalledTimes(1));

    rerender({ wsId: "ws-1", workspaceName: "Acme" });
    rerender({ wsId: "ws-1", workspaceName: "Acme Renamed" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(mockApi.ackLarkInviteWelcome).toHaveBeenCalledTimes(1);
    expect(mockApi.getLarkInviteWelcome).toHaveBeenCalledTimes(1);
  });

  it("clears the cached welcome after the ack succeeds", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(welcome());

    const { client } = mount({ wsId: "ws-1", workspaceName: "Acme" });

    await waitFor(() =>
      expect(client.getQueryData(workspaceKeys.larkInviteWelcome("ws-1"))).toBeNull(),
    );
  });

  it("stays silent and does not repeat the toast when the ack fails", async () => {
    mockApi.getLarkInviteWelcome.mockResolvedValue(welcome());
    mockApi.ackLarkInviteWelcome.mockRejectedValue(new Error("ack failed"));

    const { client, rerender } = mount({ wsId: "ws-1", workspaceName: "Acme" });
    await waitFor(() => expect(mockApi.ackLarkInviteWelcome).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 改名会让提示的 effect 重新执行，此时缓存里的记录还在，只能靠已提示的记录拦住。
    rerender({ wsId: "ws-1", workspaceName: "Acme Renamed" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    // 确认没成功就不清缓存，由服务端下次再提示。
    expect(client.getQueryData(workspaceKeys.larkInviteWelcome("ws-1"))).toEqual(welcome());
  });

  it("shows the toast for another workspace after switching", async () => {
    mockApi.getLarkInviteWelcome.mockImplementation(async (wsId: string) =>
      wsId === "ws-1" ? welcome("member") : { ...welcome("admin"), invite_id: "inv-2" },
    );

    const { rerender } = mount({ wsId: "ws-1", workspaceName: "Acme" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    rerender({ wsId: "ws-2", workspaceName: "Beta" });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenLastCalledWith("Joined Beta", {
      description: "Joined through Ada’s Feishu invite as Admin.",
    });
    expect(mockApi.ackLarkInviteWelcome).toHaveBeenLastCalledWith("ws-2");
  });
});
