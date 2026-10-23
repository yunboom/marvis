import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { LarkInvite } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";

const mockApi = vi.hoisted(() => ({
  getLarkInviteStatus: vi.fn(),
  listLarkInvites: vi.fn(),
  revokeLarkInvite: vi.fn(),
}));

vi.mock("@marvis/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/api")>()),
  api: mockApi,
}));
// 头像组件依赖成员目录和路由，这里只关心传入的身份类型和名字。
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, name }: { actorType: string; name?: string }) => (
    <span data-testid="actor-avatar" data-actor-type={actorType} data-name={name} />
  ),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { LarkInvitesView } from "./lark-invites-view";

const sentBy = { id: "user-1", name: "Ada Lovelace", avatar_url: null };

function invite(overrides: Partial<LarkInvite> & Pick<LarkInvite, "id">): LarkInvite {
  return {
    target: {
      type: "chat",
      id: `oc_${overrides.id}`,
      id_type: "chat_id",
      name: `Group ${overrides.id}`,
      avatar_url: null,
    },
    role: "member",
    status: "active",
    use_count: 0,
    max_uses: null,
    expires_at: "2026-11-01T00:00:00Z",
    revoked_at: null,
    note: "",
    sent_by: sentBy,
    sent_by_agent: null,
    created_at: "2026-10-20T00:00:00Z",
    joined: [],
    ...overrides,
  };
}

const joinedUser = (id: string) => ({
  user_id: id,
  name: `User ${id}`,
  email: `${id}@acme.dev`,
  avatar_url: null,
  joined_at: "2026-10-21T00:00:00Z",
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  renderWithI18n(
    <QueryClientProvider client={client}>
      <LarkInvitesView wsId="ws-1" />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getLarkInviteStatus.mockResolvedValue({ enabled: true });
  mockApi.listLarkInvites.mockResolvedValue([]);
  mockApi.revokeLarkInvite.mockResolvedValue(invite({ id: "a", status: "revoked" }));
});

describe("LarkInvitesView", () => {
  it("lists the four statuses and offers revoke on active rows only", async () => {
    mockApi.listLarkInvites.mockResolvedValue([
      invite({ id: "revoked", status: "revoked", revoked_at: "2026-10-22T00:00:00Z" }),
      invite({ id: "expired", status: "expired" }),
      invite({ id: "done", status: "completed", use_count: 5, max_uses: 5 }),
      invite({ id: "live", status: "active" }),
    ]);
    mount();

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Active")).toBeInTheDocument();
    expect(within(screen.getByText("Group done").closest("li")!).getByText("Completed")).toBeInTheDocument();
    expect(within(screen.getByText("Group expired").closest("li")!).getByText("Expired")).toBeInTheDocument();
    expect(within(screen.getByText("Group revoked").closest("li")!).getByText("Revoked")).toBeInTheDocument();

    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    expect(within(rows[0]!).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(mockApi.listLarkInvites).toHaveBeenCalledWith("ws-1", "all");
  });

  it("puts active invites first and the rest by creation time, newest first", async () => {
    mockApi.listLarkInvites.mockResolvedValue([
      invite({ id: "old-expired", status: "expired", created_at: "2026-10-01T00:00:00Z" }),
      invite({ id: "old-live", status: "active", created_at: "2026-10-02T00:00:00Z" }),
      invite({ id: "new-revoked", status: "revoked", created_at: "2026-10-22T00:00:00Z" }),
      invite({ id: "new-live", status: "active", created_at: "2026-10-21T00:00:00Z" }),
      invite({ id: "mid-done", status: "completed", created_at: "2026-10-10T00:00:00Z" }),
    ]);
    mount();

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^Group [\w-]+$/).textContent)).toEqual([
      "Group new-live",
      "Group old-live",
      "Group new-revoked",
      "Group mid-done",
      "Group old-expired",
    ]);
  });

  it("describes the receiver, role, joined people, expiry and sender", async () => {
    mockApi.listLarkInvites.mockResolvedValue([
      invite({
        id: "chat-open",
        role: "admin",
        use_count: 3,
        joined: [joinedUser("u1"), joinedUser("u2"), joinedUser("u3")],
      }),
      invite({ id: "chat-cap", use_count: 2, max_uses: 10 }),
      invite({ id: "chat-empty", use_count: 0 }),
      invite({
        id: "person-in",
        target: {
          type: "user",
          id: "grace@acme.dev",
          id_type: "email",
          name: "Grace Hopper",
          avatar_url: null,
        },
        status: "completed",
        use_count: 1,
        max_uses: 1,
        joined: [joinedUser("u9")],
      }),
      invite({
        id: "person-out",
        target: {
          type: "user",
          id: "ou_abc",
          id_type: "open_id",
          name: "Alan Turing",
          avatar_url: null,
        },
        sent_by: { id: "user-2", name: "Linus", avatar_url: null },
        sent_by_agent: { id: "agent-1", name: "Deploy Bot", avatar_url: null },
      }),
    ]);
    mount();
    await screen.findAllByRole("listitem");

    const row = (name: string) => screen.getByText(name).closest("li")!;

    const open = row("Group chat-open");
    expect(within(open).getByText("Group")).toBeInTheDocument();
    expect(within(open).getByText("Admin")).toBeInTheDocument();
    expect(within(open).getByText("3 people joined")).toBeInTheDocument();
    // 已加入的人用头像叠放，最多 5 个。
    expect(
      within(open)
        .getAllByTestId("actor-avatar")
        .filter((el) => el.getAttribute("data-name")?.startsWith("User")),
    ).toHaveLength(3);
    expect(within(open).getByText(/Ada Lovelace/)).toBeInTheDocument();

    expect(within(row("Group chat-cap")).getByText("2 / 10")).toBeInTheDocument();
    expect(within(row("Group chat-empty")).getByText("Not joined")).toBeInTheDocument();

    const personIn = row("Grace Hopper");
    expect(within(personIn).getByText("Person · grace@acme.dev")).toBeInTheDocument();
    expect(within(personIn).getByText("Joined")).toBeInTheDocument();
    expect(
      within(personIn).getAllByTestId("actor-avatar")[0]!.getAttribute("data-actor-type"),
    ).toBe("member");

    // 用 open_id 发出的邀请没有邮箱，不拼邮箱。
    const personOut = row("Alan Turing");
    expect(within(personOut).getByText("Person")).toBeInTheDocument();
    expect(within(personOut).getByText("Not joined")).toBeInTheDocument();
    // 智能体代发时发送人是智能体，头像用智能体样式。
    const senderAvatar = within(personOut)
      .getAllByTestId("actor-avatar")
      .find((el) => el.getAttribute("data-name") === "Deploy Bot");
    expect(senderAvatar?.getAttribute("data-actor-type")).toBe("agent");
  });

  it("draws a squad-style tile for a group without a picture and the picture when present", async () => {
    mockApi.listLarkInvites.mockResolvedValue([
      invite({ id: "plain", target: { type: "chat", id: "oc_1", id_type: "chat_id", name: "Platform", avatar_url: null } }),
      invite({
        id: "pic",
        target: {
          type: "chat",
          id: "oc_2",
          id_type: "chat_id",
          name: "Design",
          avatar_url: "https://img.example/design.png",
        },
      }),
    ]);
    mount();
    await screen.findAllByRole("listitem");

    const plain = screen.getByText("Platform").closest("li")!;
    const tile = plain.querySelector('[data-slot="lark-chat-avatar"]')!;
    expect(tile).toHaveTextContent("P");
    expect(tile.querySelector("img")).toBeNull();

    const pic = screen.getByText("Design").closest("li")!;
    expect(pic.querySelector('[data-slot="lark-chat-avatar"] img')).toHaveAttribute(
      "src",
      "https://img.example/design.png",
    );
  });

  it("revokes an invite, refetches the list and confirms with a toast", async () => {
    const user = userEvent.setup();
    mockApi.listLarkInvites.mockResolvedValue([invite({ id: "live", status: "active" })]);
    const { invalidate } = mount();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(mockApi.revokeLarkInvite).toHaveBeenCalledWith("ws-1", "live"));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces", "ws-1", "lark-invites"] }),
    );
    await waitFor(() => expect(mockApi.listLarkInvites).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith("Invite revoked");
  });

  it("refetches and reports the failure when revoking fails", async () => {
    const user = userEvent.setup();
    mockApi.listLarkInvites.mockResolvedValue([invite({ id: "live", status: "active" })]);
    mockApi.revokeLarkInvite.mockRejectedValue(new Error("boom"));
    const { invalidate } = mount();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not revoke the invite"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces", "ws-1", "lark-invites"] });
  });

  it("shows the empty state", async () => {
    mount();
    expect(await screen.findByText("No Feishu invites sent yet")).toBeInTheDocument();
    expect(screen.getByText(/Anyone who taps “Join workspace” becomes a member/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("explains that the server has no Feishu bot when the feature is off", async () => {
    mockApi.getLarkInviteStatus.mockResolvedValue({ enabled: false });
    mount();

    expect(await screen.findByText("Feishu bot is not configured on this server")).toBeInTheDocument();
    expect(screen.getByText(/A server admin needs to enable the bot capability/)).toBeInTheDocument();
    expect(mockApi.listLarkInvites).not.toHaveBeenCalled();
  });

  it("renders the Chinese copy", async () => {
    mockApi.listLarkInvites.mockResolvedValue([invite({ id: "live", status: "active", use_count: 2 })]);
    const client = new QueryClient();
    renderWithI18n(
      <QueryClientProvider client={client}>
        <LarkInvitesView wsId="ws-1" />
      </QueryClientProvider>,
      { locale: "zh-Hans" },
    );

    expect(await screen.findByText("2 人已加入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(screen.getByText(/点击“加入工作区”的人直接成为成员/)).toBeInTheDocument();
    for (const column of ["接收方", "角色", "已加入", "有效期", "发送人"]) {
      expect(screen.getAllByText(column).length).toBeGreaterThan(0);
    }
  });
});
