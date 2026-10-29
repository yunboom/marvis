import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@marvis/core/api";
import type { LarkChat, LarkInviteSendResult } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";

const mockApi = vi.hoisted(() => ({
  listLarkChats: vi.fn(),
  lookupLarkUser: vi.fn(),
  sendLarkInvites: vi.fn(),
}));

vi.mock("@marvis/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/api")>()),
  api: mockApi,
}));
vi.mock("@marvis/core/auth", () => {
  const state = { user: { id: "user-1", name: "Ada Lovelace" } };
  const useAuthStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});
vi.mock("@marvis/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ name }: { name?: string }) => <span data-testid="actor-avatar" data-name={name} />,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { LarkInviteSendDialog } from "./lark-invite-send-dialog";

const chat = (id: number, name = `Group ${id}`, memberCount = 0): LarkChat => ({
  chat_id: `oc_${id}`,
  name,
  avatar_url: null,
  member_count: memberCount,
});

const target = (id: string, name: string, type: "chat" | "user" = "chat") => ({
  type,
  id,
  id_type: type === "chat" ? "chat_id" : "email",
  name,
  avatar_url: null,
});

const sent = (id: string, name: string, type: "chat" | "user" = "chat"): LarkInviteSendResult => ({
  id: `inv-${id}`,
  target: target(id, name, type),
  role: "member",
  expires_at: "2026-11-01T00:00:00Z",
  max_uses: null,
  status: "sent",
  error: null,
});

const failed = (id: string, name: string, code: string, type: "chat" | "user" = "chat"): LarkInviteSendResult => ({
  id: null,
  target: target(id, name, type),
  role: "member",
  expires_at: null,
  max_uses: null,
  status: "failed",
  error: { code, message: "server text, not shown" },
});

const notFound = () =>
  new ApiError("user not found in Feishu", 404, "Not Found", {
    error: "user not found in Feishu",
    code: "user_not_found",
  });

function mount(
  onOpenChange: (open: boolean) => void = vi.fn(),
  client = new QueryClient({
    // 列群查询自带重试策略，会盖过这里的 retry；重试间隔压到 0，失败测试不用等。
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  }),
) {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <LarkInviteSendDialog wsId="ws-1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { invalidate, onOpenChange, ...view };
}

async function selectChats(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  for (const name of names) {
    await user.click(await screen.findByRole("checkbox", { name: new RegExp(`^${name}`) }));
  }
}

// 邀请设置默认折叠成一行摘要，改设置前先展开。
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Invite settings/ }));
}

async function addEmail(user: ReturnType<typeof userEvent.setup>, email: string) {
  const input = screen.getByRole("textbox", { name: "Email" });
  await user.type(input, `${email}{Enter}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listLarkChats.mockResolvedValue([chat(1), chat(2), chat(3, "Design", 12)]);
  mockApi.lookupLarkUser.mockImplementation(async (_ws: string, email: string) => ({
    open_id: `ou_${email}`,
    name: `Name of ${email}`,
    avatar_url: null,
    email,
  }));
  mockApi.sendLarkInvites.mockResolvedValue([]);
});

describe("LarkInviteSendDialog groups", () => {
  it("counts the selected groups on the button and sends their ids", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([sent("oc_1", "Group 1"), sent("oc_2", "Group 2")]);
    const { invalidate, onOpenChange } = mount();

    expect(screen.getByRole("button", { name: "Send to 0 groups" })).toBeDisabled();
    await selectChats(user, "Group 1", "Group 2");
    const send = screen.getByRole("button", { name: "Send to 2 groups" });
    expect(send).toBeEnabled();

    await user.click(send);

    await waitFor(() =>
      expect(mockApi.sendLarkInvites).toHaveBeenCalledWith("ws-1", {
        chat_ids: ["oc_1", "oc_2"],
        role: "member",
        expires_in_hours: 168,
        idempotency_key: expect.any(String),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("2 cards sent");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces", "ws-1", "lark-invites"] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refetches the group list every time the dialog opens", async () => {
    // 生产环境的全局 staleTime 是 Infinity，不显式重新拉取的话，刚加进群的机器人要等刷新页面才能看到。
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    mockApi.listLarkChats.mockResolvedValueOnce([chat(1)]);
    const first = mount(vi.fn(), client);
    await screen.findByRole("checkbox", { name: /^Group 1/ });
    expect(mockApi.listLarkChats).toHaveBeenCalledTimes(1);
    first.unmount();

    // 关闭期间机器人被加进了新群。
    mockApi.listLarkChats.mockResolvedValueOnce([chat(1), chat(2, "Newly added")]);
    mount(vi.fn(), client);

    expect(await screen.findByRole("checkbox", { name: /^Newly added/ })).toBeInTheDocument();
    expect(mockApi.listLarkChats).toHaveBeenCalledTimes(2);
  });

  it("filters the group list by the search box", async () => {
    const user = userEvent.setup();
    mount();

    await screen.findByRole("checkbox", { name: /^Group 1/ });
    await user.type(screen.getByRole("searchbox", { name: "Search group name" }), "des");

    expect(screen.getByRole("checkbox", { name: /^Design/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^Group 1/ })).toBeNull();
  });

  it("keeps a selection that the search filter hides", async () => {
    const user = userEvent.setup();
    mount();

    await selectChats(user, "Group 1");
    await user.type(screen.getByRole("searchbox", { name: "Search group name" }), "des");

    expect(screen.getByRole("button", { name: "Send to 1 group" })).toBeEnabled();
  });

  it("shows the member count only when the server provides one", async () => {
    mount();

    const withCount = await screen.findByRole("checkbox", { name: /^Design/ });
    expect(withCount.closest("label")).toHaveTextContent("Group · 12 members");
    const without = screen.getByRole("checkbox", { name: /^Group 1/ });
    expect(without.closest("label")).not.toHaveTextContent("members");
  });

  it("sends the chosen role, expiry, member limit and note", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([sent("oc_1", "Group 1")]);
    mount();

    await selectChats(user, "Group 1");

    await openSettings(user);
    await user.click(screen.getByRole("radio", { name: "Admin" }));
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    await user.type(screen.getByRole("spinbutton", { name: "Member limit" }), "20");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Welcome aboard");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    await waitFor(() =>
      expect(mockApi.sendLarkInvites).toHaveBeenCalledWith("ws-1", {
        chat_ids: ["oc_1"],
        role: "admin",
        expires_in_hours: 720,
        max_uses: 20,
        note: "Welcome aboard",
        idempotency_key: expect.any(String),
      }),
    );
  });

  it("limits the note to 200 characters", async () => {
    const user = userEvent.setup();
    mount();
    await openSettings(user);
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveAttribute("maxlength", "200");
  });

  it("blocks sending while the member limit is not a positive whole number", async () => {
    const user = userEvent.setup();
    mount();
    await selectChats(user, "Group 1");
    await openSettings(user);
    const limit = screen.getByRole("spinbutton", { name: "Member limit" });
    const send = screen.getByRole("button", { name: "Send to 1 group" });

    await user.type(limit, "0");
    expect(limit).toHaveAttribute("aria-invalid", "true");
    expect(send).toBeDisabled();

    await user.clear(limit);
    await user.type(limit, "1.5");
    expect(send).toBeDisabled();

    await user.clear(limit);
    expect(limit).not.toHaveAttribute("aria-invalid");
    expect(send).toBeEnabled();
  });

  it("only offers the member limit on the groups tab", async () => {
    const user = userEvent.setup();
    mount();
    await openSettings(user);

    expect(screen.getByRole("spinbutton", { name: "Member limit" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^People/ }));
    expect(screen.queryByRole("spinbutton", { name: "Member limit" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: /^Groups/ }));
    expect(screen.getByRole("spinbutton", { name: "Member limit" })).toBeInTheDocument();
  });

  it("blocks sending to more than 50 receivers", async () => {
    mockApi.listLarkChats.mockResolvedValue(Array.from({ length: 51 }, (_, i) => chat(i + 1)));
    mount();

    const boxes = await screen.findAllByRole("checkbox");
    for (const box of boxes.slice(0, 50)) fireEvent.click(box);
    expect(screen.getByRole("button", { name: "Send to 50 groups" })).toBeEnabled();
    expect(screen.queryByText("At most 50 receivers per send")).toBeNull();

    fireEvent.click(boxes[50]!);
    expect(screen.getByRole("button", { name: "Send to 51 groups" })).toBeDisabled();
    expect(screen.getByText("At most 50 receivers per send")).toBeInTheDocument();
  });

  it("explains an empty group list", async () => {
    mockApi.listLarkChats.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No groups to choose from")).toBeInTheDocument();
  });

  it("explains when the group list fails to load", async () => {
    mockApi.listLarkChats.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText("Could not load groups")).toBeInTheDocument();
    // 非 4xx 的失败保留一次重试，所以请求两次。
    expect(mockApi.listLarkChats).toHaveBeenCalledTimes(2);
  });

  it("shows the localized not-configured error when the group list is refused", async () => {
    mockApi.listLarkChats.mockRejectedValue(
      new ApiError("the Feishu app's bot ability is not enabled", 403, "Forbidden", {
        error: "the Feishu app's bot ability is not enabled",
        code: "lark_not_configured",
      }),
    );
    mount();
    expect(await screen.findByText("Feishu app configuration is incomplete")).toBeInTheDocument();
    expect(screen.queryByText("Could not load groups")).not.toBeInTheDocument();
    expect(screen.queryByText(/bot ability/)).not.toBeInTheDocument();
    // 4xx 重试不会成功，只请求一次。
    expect(mockApi.listLarkChats).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic failure for an error code the dialog does not know", async () => {
    mockApi.listLarkChats.mockRejectedValue(
      new ApiError("odd", 502, "Bad Gateway", { error: "odd", code: "something_new" }),
    );
    mount();
    expect(await screen.findByText("Could not load groups")).toBeInTheDocument();
  });
});

describe("LarkInviteSendDialog people", () => {
  it("adds an email as a chip after looking it up and sends only emails that resolve", async () => {
    const user = userEvent.setup();
    mockApi.lookupLarkUser.mockImplementation(async (_ws: string, email: string) => {
      if (email === "ghost@acme.dev") throw notFound();
      return { open_id: "ou_ada", name: "Ada Lovelace", avatar_url: null, email };
    });
    mockApi.sendLarkInvites.mockResolvedValue([sent("ada@acme.dev", "Ada Lovelace", "user")]);
    mount();

    await user.click(screen.getByRole("tab", { name: /^People/ }));
    await addEmail(user, "ada@acme.dev");
    await addEmail(user, "ghost@acme.dev");

    expect(mockApi.lookupLarkUser).toHaveBeenCalledWith("ws-1", "ada@acme.dev");
    expect(mockApi.lookupLarkUser).toHaveBeenCalledWith("ws-1", "ghost@acme.dev");

    const found = await screen.findByTestId("lark-email-chip-ada@acme.dev");
    expect(within(found).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(found).getByText("ada@acme.dev")).toBeInTheDocument();
    expect(found).toHaveAttribute("data-state", "found");

    const missing = await screen.findByTestId("lark-email-chip-ghost@acme.dev");
    expect(missing).toHaveAttribute("data-state", "unavailable");
    expect(missing.className).toMatch(/destructive/);
    expect(within(missing).getByText("Not in Feishu, will be skipped")).toBeInTheDocument();

    // 只有查到的邮箱计入人数，也只有它进提交参数。
    const send = screen.getByRole("button", { name: "Send to 1 person" });
    await user.click(send);
    await waitFor(() =>
      expect(mockApi.sendLarkInvites).toHaveBeenCalledWith("ws-1", {
        user_emails: ["ada@acme.dev"],
        role: "member",
        expires_in_hours: 168,
        idempotency_key: expect.any(String),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("1 card sent");
  });

  it("does not look up the same email twice and normalizes its case", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));

    await addEmail(user, "Ada@Acme.dev");
    await addEmail(user, "ada@acme.dev");

    await screen.findByTestId("lark-email-chip-ada@acme.dev");
    expect(mockApi.lookupLarkUser).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(/lark-email-chip-/)).toHaveLength(1);
  });

  it("rejects text that is not an email without calling the server", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));

    await addEmail(user, "not-an-email");

    expect(mockApi.lookupLarkUser).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/lark-email-chip-/)).toHaveLength(0);
  });

  it("marks an email outside the app scope with the mapped reason", async () => {
    const user = userEvent.setup();
    mockApi.lookupLarkUser.mockRejectedValue(
      new ApiError("outside scope", 404, "Not Found", { error: "outside scope", code: "user_not_in_app_scope" }),
    );
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));

    await addEmail(user, "far@acme.dev");

    const chip = await screen.findByTestId("lark-email-chip-far@acme.dev");
    expect(chip).toHaveAttribute("data-state", "unavailable");
    expect(within(chip).getByText("Outside Marvis Workbench’s availability scope")).toBeInTheDocument();
  });

  it("keeps the typed email and reports an unexpected lookup failure", async () => {
    const user = userEvent.setup();
    mockApi.lookupLarkUser.mockRejectedValue(new Error("network down"));
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));

    await addEmail(user, "ada@acme.dev");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not look up the Feishu user"));
    expect(screen.queryAllByTestId(/lark-email-chip-/)).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("ada@acme.dev");
  });

  it("removes a chip", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));
    await addEmail(user, "ada@acme.dev");
    await screen.findByTestId("lark-email-chip-ada@acme.dev");

    await user.click(screen.getByRole("button", { name: "Remove ada@acme.dev" }));

    expect(screen.queryByTestId("lark-email-chip-ada@acme.dev")).toBeNull();
    expect(screen.getByRole("button", { name: "Send to 0 people" })).toBeDisabled();
  });

  it("sends the active tab only and keeps the other tab's selection", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([sent("ada@acme.dev", "Ada", "user")]);
    mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("tab", { name: /^People/ }));
    await addEmail(user, "ada@acme.dev");
    await screen.findByTestId("lark-email-chip-ada@acme.dev");
    await user.click(screen.getByRole("button", { name: "Send to 1 person" }));

    await waitFor(() => expect(mockApi.sendLarkInvites).toHaveBeenCalledTimes(1));
    expect(mockApi.sendLarkInvites.mock.calls[0]![1]).not.toHaveProperty("chat_ids");
    expect(mockApi.sendLarkInvites.mock.calls[0]![1]).not.toHaveProperty("max_uses");
  });
});

describe("LarkInviteSendDialog results", () => {
  it("switches to a result screen with the sent summary and every failed receiver", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([
      sent("oc_1", "Group 1"),
      // 解析失败的接收方服务端不带名字，界面按群列表补上。
      failed("oc_2", "", "bot_not_in_chat"),
      failed("oc_3", "Design", "send_failed"),
    ]);
    const { onOpenChange, invalidate } = mount();

    await selectChats(user, "Group 1", "Group 2", "Design");
    await user.click(screen.getByRole("button", { name: "Send to 3 groups" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("2 not sent")).toBeInTheDocument();
    expect(within(alert).getByText("Group 2")).toBeInTheDocument();
    expect(within(alert).getByText("Marvis Workbench is not in this group")).toBeInTheDocument();
    expect(within(alert).getByText("Design")).toBeInTheDocument();
    expect(within(alert).getByText("Sending failed")).toBeInTheDocument();
    expect(within(alert).queryByText("Group 1")).toBeNull();
    expect(within(alert).queryByText(/server text/)).toBeNull();

    // 已发出的写在结果页上，不再另弹 toast。
    expect(screen.getByText("1 card sent")).toBeInTheDocument();
    expect(screen.getByText("Group 1")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces", "ws-1", "lark-invites"] });

    // 返回修改后，已发送的群从选择里去掉，重试只发失败的。
    await user.click(screen.getByRole("button", { name: "Back to edit" }));
    expect(screen.getByRole("button", { name: "Send to 2 groups" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /^Group 1/ })).toHaveAttribute("aria-checked", "false");
  });

  it("sends one idempotency key for every submit from the same open and a new one after reopening", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites
      .mockResolvedValueOnce([sent("oc_1", "Group 1"), failed("oc_2", "Group 2", "send_failed")])
      .mockResolvedValueOnce([sent("oc_2", "Group 2")])
      .mockResolvedValueOnce([sent("oc_1", "Group 1")]);
    const first = mount();

    await selectChats(user, "Group 1", "Group 2");
    await user.click(screen.getByRole("button", { name: "Send to 2 groups" }));
    // 重试只发失败的群，沿用这次打开弹窗时生成的键，服务端据此避免重复发卡片。
    await user.click(await screen.findByRole("button", { name: "Back to edit" }));
    await user.click(await screen.findByRole("button", { name: "Send to 1 group" }));
    await waitFor(() => expect(mockApi.sendLarkInvites).toHaveBeenCalledTimes(2));

    const firstKey = mockApi.sendLarkInvites.mock.calls[0]![1].idempotency_key;
    expect(typeof firstKey).toBe("string");
    expect(firstKey.length).toBeGreaterThan(0);
    expect(firstKey.length).toBeLessThanOrEqual(50);
    expect(mockApi.sendLarkInvites.mock.calls[1]![1]).toEqual({
      chat_ids: ["oc_2"],
      role: "member",
      expires_in_hours: 168,
      idempotency_key: firstKey,
    });

    // 关闭后重新打开是一次新的发送，换一个键。
    first.unmount();
    mount();
    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));
    await waitFor(() => expect(mockApi.sendLarkInvites).toHaveBeenCalledTimes(3));
    expect(mockApi.sendLarkInvites.mock.calls[2]![1].idempotency_key).not.toBe(firstKey);
  });

  it("reports nothing as sent when every receiver failed", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([failed("oc_1", "Group 1", "bot_not_in_chat")]);
    mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/card sent|cards sent/)).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows the failed email's mapped reason", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([
      failed("ada@acme.dev", "ada@acme.dev", "user_not_in_app_scope", "user"),
    ]);
    mount();
    await user.click(screen.getByRole("tab", { name: /^People/ }));
    await addEmail(user, "ada@acme.dev");
    await screen.findByTestId("lark-email-chip-ada@acme.dev");
    await user.click(screen.getByRole("button", { name: "Send to 1 person" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("ada@acme.dev")).toBeInTheDocument();
    expect(within(alert).getByText("Outside Marvis Workbench’s availability scope")).toBeInTheDocument();
  });

  it("treats an empty result list as submitted instead of nothing sent", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([]);
    const { invalidate, onOpenChange } = mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Submitted, results will update shortly"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces", "ws-1", "lark-invites"] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the selection and shows the mapped error when the whole request fails", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", { error: "forbidden", code: "permission_denied" }),
    );
    const { onOpenChange } = mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Requires an owner or admin"),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Send to 1 group" })).toBeEnabled();
  });

  it("falls back to the generic reason for an unknown error code", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([failed("oc_1", "Group 1", "something_new")]);
    mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Sending failed")).toBeInTheDocument();
  });

  it("disables the button while sending so a click cannot send twice", async () => {
    const user = userEvent.setup();
    let resolve: (value: LarkInviteSendResult[]) => void = () => {};
    mockApi.sendLarkInvites.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));

    const busy = await screen.findByRole("button", { name: "Sending" });
    expect(busy).toBeDisabled();
    await act(async () => resolve([sent("oc_1", "Group 1")]));
    expect(mockApi.sendLarkInvites).toHaveBeenCalledTimes(1);
  });
});

describe("LarkInviteSendDialog layout", () => {
  it("has no card preview", () => {
    mount();
    expect(screen.queryByRole("region", { name: "Card preview" })).toBeNull();
    expect(screen.queryByText("Join workspace")).toBeNull();
  });

  it("collapses the settings into a summary that follows the choices", async () => {
    const user = userEvent.setup();
    mount();

    const toggle = screen.getByRole("button", { name: /^Invite settings/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Member · Valid for 7 days · No member limit");
    expect(screen.queryByRole("radio", { name: "Admin" })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("radio", { name: "Admin" }));
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    await user.type(screen.getByRole("spinbutton", { name: "Member limit" }), "20");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Hi");
    expect(screen.getByText("2 / 200")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Admin · Valid for 30 days · Up to 20 members · With note");

    // 个人邀请没有人数上限，摘要里也不提。
    await user.click(screen.getByRole("tab", { name: /^People/ }));
    expect(toggle).toHaveTextContent("Admin · Valid for 30 days · With note");
  });

  it("keeps the settings open while the member limit is invalid", async () => {
    const user = userEvent.setup();
    mount();

    await openSettings(user);
    await user.type(screen.getByRole("spinbutton", { name: "Member limit" }), "0");
    await user.click(screen.getByRole("button", { name: /^Invite settings/ }));

    expect(screen.getByRole("spinbutton", { name: "Member limit" })).toBeInTheDocument();
  });

  it("counts the chosen receivers on each switch", async () => {
    const user = userEvent.setup();
    mount();

    await selectChats(user, "Group 1", "Group 2");
    expect(screen.getByRole("tab", { name: /^Groups/ })).toHaveTextContent("Groups2");
    expect(screen.getByRole("tab", { name: /^People/ })).toHaveTextContent("People0");
  });

  it("closes from the result screen", async () => {
    const user = userEvent.setup();
    mockApi.sendLarkInvites.mockResolvedValue([failed("oc_1", "Group 1", "send_failed")]);
    const { onOpenChange } = mount();

    await selectChats(user, "Group 1");
    await user.click(screen.getByRole("button", { name: "Send to 1 group" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("states that the card is sent as the bot", () => {
    mount();
    expect(screen.getByText("Sent as Marvis Workbench")).toBeInTheDocument();
  });

  it("renders the Chinese copy", async () => {
    const client = new QueryClient();
    renderWithI18n(
      <QueryClientProvider client={client}>
        <LarkInviteSendDialog wsId="ws-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
      { locale: "zh-Hans" },
    );

    expect(screen.getByRole("heading", { name: "发送飞书邀请" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^群聊/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^个人/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送到 0 个群" })).toBeInTheDocument();
    expect(screen.getByText("以 Marvis Workbench 的名义发送")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^邀请设置/ })).toHaveTextContent("成员 · 7 天内有效 · 人数不限");
    expect(await screen.findByRole("checkbox", { name: /^Group 1/ })).toBeInTheDocument();
  });
});
