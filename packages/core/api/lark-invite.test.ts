// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, errorCode } from "./client";

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body?: unknown) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestOf(fetch: ReturnType<typeof vi.fn>) {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
  const parsed = new URL(url);
  return { pathname: parsed.pathname, search: parsed.search, init };
}

const api = () => new ApiClient("https://api.example.test");

const invite = {
  id: "invite-1",
  target: { type: "chat", id: "oc_1", id_type: "chat_id", name: "Team", avatar_url: null },
  role: "member",
  status: "active",
  use_count: 0,
  max_uses: null,
  expires_at: "2026-10-30T00:00:00Z",
  revoked_at: null,
  note: "",
  sent_by: { id: "user-1", name: "Bob", avatar_url: null },
  sent_by_agent: null,
  created_at: "2026-10-23T00:00:00Z",
  joined: [],
};

describe("Feishu invite API", () => {
  it("reads whether Feishu invites are enabled", async () => {
    const fetch = respond(200, { enabled: true });
    await expect(api().getLarkInviteStatus()).resolves.toEqual({ enabled: true });
    expect(requestOf(fetch).pathname).toBe("/api/lark/status");
  });

  it("treats a malformed status response as disabled", async () => {
    respond(200, null);
    await expect(api().getLarkInviteStatus()).resolves.toEqual({ enabled: false });
  });

  describe("listLarkInvites", () => {
    it("omits the status filter by default so the server applies its own default", async () => {
      const fetch = respond(200, [invite]);
      const invites = await api().listLarkInvites("ws-1");
      const req = requestOf(fetch);
      expect(req.pathname).toBe("/api/workspaces/ws-1/lark-invites");
      expect(req.search).toBe("");
      expect(invites).toHaveLength(1);
      expect(invites[0]?.id).toBe("invite-1");
    });

    it.each(["active", "completed", "expired", "revoked", "all"] as const)("sends status=%s", async (status) => {
      const fetch = respond(200, []);
      await api().listLarkInvites("ws-1", status);
      expect(requestOf(fetch).search).toBe(`?status=${status}`);
    });

    it.each([null, {}, "oops"])("returns an empty list for malformed response %j", async (body) => {
      respond(200, body);
      await expect(api().listLarkInvites("ws-1")).resolves.toEqual([]);
    });
  });

  describe("sendLarkInvites", () => {
    it("posts the request and returns the results array", async () => {
      const fetch = respond(200, {
        results: [
          { id: "invite-1", target: invite.target, role: "member", expires_at: "2026-10-30T00:00:00Z", max_uses: 5, status: "sent", error: null },
          {
            id: null,
            target: { ...invite.target, id: "oc_2" },
            role: "member",
            expires_at: null,
            max_uses: null,
            status: "failed",
            error: { code: "bot_not_in_chat", message: "the Marvis bot is not in this chat" },
          },
        ],
      });
      const data = { chat_ids: ["oc_1", "oc_2"], role: "member" as const, expires_in_hours: 168, max_uses: 5, note: "hi" };
      const results = await api().sendLarkInvites("ws-1", data);

      const req = requestOf(fetch);
      expect(req.pathname).toBe("/api/workspaces/ws-1/lark-invites");
      expect(req.init?.method).toBe("POST");
      expect(JSON.parse(String(req.init?.body))).toEqual(data);
      expect(results.map((r) => r.status)).toEqual(["sent", "failed"]);
      expect(results[1]?.error?.code).toBe("bot_not_in_chat");
    });

    it("sends the idempotency key in the body", async () => {
      const fetch = respond(200, { results: [] });
      await api().sendLarkInvites("ws-1", {
        chat_ids: ["oc_1"],
        role: "member",
        expires_in_hours: 24,
        idempotency_key: "dialog-key-1",
      });
      expect(JSON.parse(String(requestOf(fetch).init?.body))).toEqual({
        chat_ids: ["oc_1"],
        role: "member",
        expires_in_hours: 24,
        idempotency_key: "dialog-key-1",
      });
    });

    it.each([null, [], "oops"])("returns an empty list for malformed response %j", async (body) => {
      respond(200, body);
      await expect(
        api().sendLarkInvites("ws-1", { user_emails: ["a@example.test"], role: "member", expires_in_hours: 24 }),
      ).resolves.toEqual([]);
    });
  });

  it("revokes an invite and returns the updated invite", async () => {
    const fetch = respond(200, { ...invite, status: "revoked", revoked_at: "2026-10-24T00:00:00Z" });
    const revoked = await api().revokeLarkInvite("ws-1", "invite-1");
    const req = requestOf(fetch);
    expect(req.pathname).toBe("/api/workspaces/ws-1/lark-invites/invite-1");
    expect(req.init?.method).toBe("DELETE");
    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_at).toBe("2026-10-24T00:00:00Z");
  });

  describe("listLarkChats", () => {
    it("lists the chats the bot is in", async () => {
      const fetch = respond(200, [{ chat_id: "oc_1", name: "Team", avatar_url: null, member_count: 0 }]);
      await expect(api().listLarkChats("ws-1")).resolves.toEqual([
        { chat_id: "oc_1", name: "Team", avatar_url: null, member_count: 0 },
      ]);
      expect(requestOf(fetch).pathname).toBe("/api/workspaces/ws-1/lark/chats");
    });

    it("returns an empty list for a malformed response", async () => {
      respond(200, null);
      await expect(api().listLarkChats("ws-1")).resolves.toEqual([]);
    });
  });

  describe("lookupLarkUser", () => {
    it("encodes the email and returns the user", async () => {
      const fetch = respond(200, { open_id: "ou_1", name: "Alice", avatar_url: null, email: "a+b@example.test" });
      await expect(api().lookupLarkUser("ws-1", "a+b@example.test")).resolves.toEqual({
        open_id: "ou_1",
        name: "Alice",
        avatar_url: null,
        email: "a+b@example.test",
      });
      const req = requestOf(fetch);
      expect(req.pathname).toBe("/api/workspaces/ws-1/lark/users/lookup");
      expect(new URLSearchParams(req.search).get("email")).toBe("a+b@example.test");
    });

    it("exposes the user_not_found code on a 404", async () => {
      respond(404, { error: "user not found in Feishu", code: "user_not_found" });
      const err = await api().lookupLarkUser("ws-1", "nobody@example.test").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect(errorCode(err)).toBe("user_not_found");
    });

    // 畸形响应不能被当成“查到了一个空用户”。
    it.each([null, {}, { open_id: "" }])("rejects malformed response %j", async (body) => {
      respond(200, body);
      await expect(api().lookupLarkUser("ws-1", "a@example.test")).rejects.toThrow("Malformed response");
    });
  });

  describe("getLarkInviteWelcome", () => {
    it("returns null on 204", async () => {
      const fetch = respond(204);
      await expect(api().getLarkInviteWelcome("ws-1")).resolves.toBeNull();
      expect(requestOf(fetch).pathname).toBe("/api/workspaces/ws-1/lark-invites/welcome");
    });

    it("returns the welcome on 200", async () => {
      respond(200, { invite_id: "invite-1", inviter_name: "Bob", role: "admin" });
      await expect(api().getLarkInviteWelcome("ws-1")).resolves.toEqual({
        invite_id: "invite-1",
        inviter_name: "Bob",
        role: "admin",
      });
    });

    it.each([null, {}, "oops"])("returns null for malformed response %j", async (body) => {
      respond(200, body);
      await expect(api().getLarkInviteWelcome("ws-1")).resolves.toBeNull();
    });
  });

  it("acknowledges the welcome", async () => {
    const fetch = respond(204);
    await expect(api().ackLarkInviteWelcome("ws-1")).resolves.toBeUndefined();
    const req = requestOf(fetch);
    expect(req.pathname).toBe("/api/workspaces/ws-1/lark-invites/welcome/ack");
    expect(req.init?.method).toBe("POST");
  });
});
