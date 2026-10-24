// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import type { Agent } from "@marvis/core/types";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

const digestRef = vi.hoisted(() => ({ current: null as unknown }));
const apiMock = vi.hoisted(() => ({
  createKnowledgeDigest: vi.fn(() => Promise.resolve()),
  updateAutopilot: vi.fn(() => Promise.resolve()),
}));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/paths", () => ({ useWorkspacePaths: () => ({ autopilotDetail: (id: string) => `/acme/autopilots/${id}` }) }));
vi.mock("@marvis/core/api", () => ({ api: apiMock, clientErrorMessage: () => "" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgeDigestOptions: () => ({ queryKey: ["digest"], queryFn: () => Promise.resolve(digestRef.current) }),
}));

import { cronToDailyTime, dailyCron, KnowledgeDigestSection } from "./knowledge-digest-section";

const agents = [{ id: "agent-1", name: "Marvis", archived_at: null }] as unknown as Agent[];

function renderSection(isAdmin = true) {
  const navigation: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/knowledge",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
  };
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NavigationProvider value={navigation}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <KnowledgeDigestSection agents={agents} defaultAgentId="agent-1" isAdmin={isAdmin} />
        </QueryClientProvider>
      </NavigationProvider>
    </I18nProvider>,
  );
}

const configured = (status: string, count = 1) => ({
  autopilot: { id: "ap-1", status, assignee_id: "agent-1", pause_reason: null },
  schedule: { id: "tr-1", cron_expression: "0 22 * * *", timezone: "Asia/Shanghai" },
  knowledge_base_count: count,
});

describe("daily cron helpers", () => {
  it("round-trips a daily time and rejects other schedules", () => {
    expect(dailyCron("07:05")).toBe("5 7 * * *");
    expect(cronToDailyTime("5 7 * * *")).toBe("07:05");
    expect(cronToDailyTime("0 9 * * 1")).toBeNull();
    expect(cronToDailyTime(null)).toBeNull();
  });
});

describe("KnowledgeDigestSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    digestRef.current = { autopilot: null, schedule: null, knowledge_base_count: 1 };
  });

  it("sets up the digest with the chosen time", async () => {
    renderSection();
    const time = await screen.findByLabelText("Time");
    await userEvent.clear(time);
    await userEvent.type(time, "07:30");
    await userEvent.click(screen.getByRole("button", { name: "Set up" }));
    await waitFor(() =>
      expect(apiMock.createKnowledgeDigest).toHaveBeenCalledWith(expect.objectContaining({ assignee_id: "agent-1", cron_expression: "30 7 * * *" })),
    );
  });

  it("tells members who sets it up", async () => {
    renderSection(false);
    expect(await screen.findByText("An owner or admin sets this up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("enables a configured digest and links to its automation", async () => {
    digestRef.current = configured("paused");
    renderSection();
    expect(await screen.findByText("Every day at 22:00 (Asia/Shanghai)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in automations" }).getAttribute("href")).toBe("/acme/autopilots/ap-1");
    await userEvent.click(screen.getByRole("switch", { name: "Enable the daily knowledge digest" }));
    await waitFor(() => expect(apiMock.updateAutopilot).toHaveBeenCalledWith("ap-1", { status: "active" }));
  });

  it("cannot be enabled without a knowledge base", async () => {
    digestRef.current = configured("paused", 0);
    renderSection();
    expect(await screen.findByText("Create a knowledge base to enable it")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Enable the daily knowledge digest" }));
    expect(apiMock.updateAutopilot).not.toHaveBeenCalled();
  });
});
