import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { Agent, Workspace } from "../types";
import {
  agentListOptions,
  larkChatListOptions,
  larkInviteListOptions,
  larkInviteStatusOptions,
  larkInviteWelcomeOptions,
  larkStatusKey,
  workspaceBySlugOptions,
  workspaceKeys,
} from "./queries";

function makeWorkspace(slug: string): Workspace {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    description: null,
    context: null,
    settings: {},
    repos: [],
    issue_prefix: slug.toUpperCase(),
    avatar_url: null,
    created_at: "",
    updated_at: "",
  };
}

describe("workspaceBySlugOptions", () => {
  const workspaces = [makeWorkspace("acme")];

  it("selects a matching workspace", () => {
    expect(workspaceBySlugOptions("acme").select?.(workspaces)).toEqual(
      workspaces[0],
    );
  });

  it("returns null after an authoritative list omits the slug", () => {
    expect(workspaceBySlugOptions("missing").select?.(workspaces)).toBeNull();
  });
});

describe("agentListOptions", () => {
  it("polls only while projected runtime availability can age offline", () => {
    const options = agentListOptions("ws-1");
    const interval = options.refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function") return;

    const queryState = (data: Agent[]) =>
      interval({ state: { status: "success", data } } as never);

    expect(
      queryState([{ runtime_availability: "online" } as Agent]),
    ).toBe(30_000);
    expect(
      queryState([{ runtime_availability: "unstable" } as Agent]),
    ).toBe(30_000);
    expect(
      queryState([{ runtime_availability: "offline" } as Agent]),
    ).toBe(false);
    expect(
      queryState([{ runtime_availability: undefined } as Agent]),
    ).toBe(false);
    expect(
      queryState([
        {
          archived_at: "2026-09-04T00:00:00Z",
          runtime_availability: "online",
        } as Agent,
      ]),
    ).toBe(false);
    expect(queryState([])).toBe(false);
  });
});

describe("Feishu invite queries", () => {
  it("scopes workspace keys by wsId and keeps the status key account-level", () => {
    expect(workspaceKeys.larkInvites("ws-1")).toEqual(["workspaces", "ws-1", "lark-invites"]);
    expect(workspaceKeys.larkChats("ws-1")).toEqual(["workspaces", "ws-1", "lark-chats"]);
    expect(workspaceKeys.larkInvites("ws-1")).not.toEqual(workspaceKeys.larkInvites("ws-2"));
    expect(larkStatusKey).toEqual(["lark", "invite-status"]);
    expect(larkInviteStatusOptions().queryKey).toEqual(larkStatusKey);
  });

  it("only fetches the invite list and chats when enabled and a workspace is known", () => {
    expect(larkInviteListOptions("ws-1", true).enabled).toBe(true);
    expect(larkInviteListOptions("ws-1", false).enabled).toBe(false);
    expect(larkInviteListOptions("", true).enabled).toBe(false);
    expect(larkChatListOptions("ws-1", true).enabled).toBe(true);
    expect(larkChatListOptions("ws-1", false).enabled).toBe(false);
    expect(larkChatListOptions("", true).enabled).toBe(false);
  });

  it("uses the workspace keys for the list and chat options", () => {
    expect(larkInviteListOptions("ws-1", true).queryKey).toEqual(workspaceKeys.larkInvites("ws-1"));
    expect(larkChatListOptions("ws-1", true).queryKey).toEqual(workspaceKeys.larkChats("ws-1"));
  });

  it("does not retry the chat list on a 4xx ApiError", () => {
    const retry = larkChatListOptions("ws-1").retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") return;

    for (const status of [400, 403, 404, 429, 499]) {
      const err = new ApiError("refused", status, "Refused", { code: "lark_not_configured" });
      expect(retry(0, err)).toBe(false);
    }
  });

  it("keeps one retry for the chat list on other errors", () => {
    const retry = larkChatListOptions("ws-1").retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") return;

    const serverError = new ApiError("boom", 502, "Bad Gateway");
    expect(retry(0, serverError)).toBe(true);
    expect(retry(1, serverError)).toBe(false);

    const network = new TypeError("Failed to fetch");
    expect(retry(0, network)).toBe(true);
    expect(retry(1, network)).toBe(false);
  });

  describe("chat list retries against a real query client", () => {
    afterEach(() => setApiInstance(null as unknown as ApiClient));

    // 把重试间隔压到 0，只看请求次数。
    async function fetchChats(listLarkChats: () => Promise<never>) {
      setApiInstance({ listLarkChats } as unknown as ApiClient);
      const client = new QueryClient();
      const result = await client
        .fetchQuery({ ...larkChatListOptions("ws-1"), retryDelay: 0 })
        .catch((err: unknown) => err);
      client.clear();

      return result;
    }

    it("asks the server once when it refuses with a 4xx", async () => {
      const listLarkChats = vi.fn(() =>
        Promise.reject(new ApiError("not configured", 403, "Forbidden", { code: "lark_not_configured" })),
      );

      const result = await fetchChats(listLarkChats);

      expect(result).toBeInstanceOf(ApiError);
      expect(listLarkChats).toHaveBeenCalledTimes(1);
    });

    it("asks the server twice when it fails with a 5xx", async () => {
      const listLarkChats = vi.fn(() => Promise.reject(new ApiError("boom", 502, "Bad Gateway")));

      const result = await fetchChats(listLarkChats);

      expect(result).toBeInstanceOf(ApiError);
      expect(listLarkChats).toHaveBeenCalledTimes(2);
    });
  });

  it("fetches the welcome once per workspace and never refetches on its own", () => {
    const options = larkInviteWelcomeOptions("ws-1");

    expect(options.queryKey).toEqual(["workspaces", "ws-1", "lark-invite-welcome"]);
    expect(options.queryKey).toEqual(workspaceKeys.larkInviteWelcome("ws-1"));
    expect(options.queryKey).not.toEqual(workspaceKeys.larkInviteWelcome("ws-2"));
    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.enabled).toBe(true);
    expect(larkInviteWelcomeOptions("").enabled).toBe(false);
  });
});
