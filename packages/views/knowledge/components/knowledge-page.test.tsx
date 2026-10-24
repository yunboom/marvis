// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

const basesRef = vi.hoisted(() => ({ current: [] as unknown[] }));
const memberRef = vi.hoisted(() => ({ current: { userId: "user-1", role: "member" as string | null } }));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  // Constants (page groups, domains) stay real; every query is stubbed.
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgeBaseListOptions: (wsId: string) => ({
    queryKey: ["kb", wsId],
    queryFn: () => Promise.resolve(basesRef.current),
  }),
  knowledgeDeleteImpactOptions: (wsId: string, id: string, enabled: boolean) => ({
    queryKey: ["kb-impact", wsId, id],
    queryFn: () => Promise.resolve({ open_annotations: 0, open_change_requests: 0, last_knowledge_base: false }),
    enabled,
  }),
  knowledgePageListOptions: (wsId: string, id: string) => ({
    queryKey: ["kb-pages", wsId, id],
    queryFn: () => Promise.resolve({ commit: "c1", pages: [] }),
  }),
  knowledgePageOptions: (wsId: string, id: string, path: string | null) => ({
    queryKey: ["kb-page", wsId, id, path],
    queryFn: () => Promise.resolve(null),
    enabled: false,
  }),
  knowledgeSearchOptions: (wsId: string, q: string) => ({
    queryKey: ["kb-search", wsId, q],
    queryFn: () => Promise.resolve({ hits: [], gap: null }),
    enabled: false,
  }),
  knowledgeGapListOptions: (wsId: string, status: string) => ({
    queryKey: ["kb-gaps", wsId, status],
    queryFn: () => Promise.resolve([]),
  }),
  knowledgeDigestOptions: (wsId: string) => ({
    queryKey: ["kb-digest", wsId],
    queryFn: () => Promise.resolve({ autopilot: null, schedule: null, knowledge_base_count: 1 }),
  }),
  knowledgeKeys: { all: (wsId: string) => ["kb", wsId], bases: (wsId: string) => ["kb", wsId], digest: (wsId: string) => ["kb-digest", wsId] },
}));
vi.mock("@marvis/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/paths")>()),
  useWorkspacePaths: () => ({ autopilotDetail: (id: string) => `/acme/autopilots/${id}` }),
}));
vi.mock("@marvis/core/workspace/queries", () => ({
  agentListOptions: (wsId: string) => ({ queryKey: ["agents", wsId], queryFn: () => Promise.resolve([]) }),
}));
vi.mock("@marvis/core/permissions", () => ({
  useCurrentMember: () => ({ ...memberRef.current, member: null, isLoading: false }),
}));
vi.mock("@marvis/core/api", () => ({
  api: { createKnowledgeBase: vi.fn(), updateKnowledgeBase: vi.fn(), deleteKnowledgeBase: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { KnowledgePage } from "./knowledge-page";

const teamBase = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "Team",
  slug: "team",
  description: "Team knowledge",
  maintainer_agent_id: null,
  created_by: "someone-else",
  page_count: 3,
  created_at: "",
  updated_at: "",
};

function renderPage(searchParams = new URLSearchParams()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigation: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/knowledge",
    searchParams,
    hash: "",
    getShareableUrl: (path) => path,
  };
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NavigationProvider value={navigation}>
        <QueryClientProvider client={queryClient}>
          <KnowledgePage />
        </QueryClientProvider>
      </NavigationProvider>
    </I18nProvider>,
  );
}

describe("KnowledgePage", () => {
  beforeEach(() => {
    basesRef.current = [];
    memberRef.current = { userId: "user-1", role: "member" };
  });

  it("offers to create a knowledge base when there is none", async () => {
    renderPage();
    expect(await screen.findByText("No knowledge bases yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New knowledge base" })).toBeTruthy();
  });

  it("shows the selected knowledge base with its page count", async () => {
    basesRef.current = [teamBase];
    renderPage();
    expect(await screen.findByRole("button", { name: "Switch knowledge base" })).toBeTruthy();
    expect(screen.getByText("Pages: 3 · Maintainer: Not set")).toBeTruthy();
  });

  it("keeps settings read-only and hides delete for a plain member", async () => {
    basesRef.current = [teamBase];
    renderPage(new URLSearchParams("tab=settings"));
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("lets an admin delete", async () => {
    basesRef.current = [teamBase];
    memberRef.current = { userId: "user-1", role: "admin" };
    renderPage(new URLSearchParams("tab=settings"));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeTruthy();
    expect(((await screen.findByLabelText("Name")) as HTMLInputElement).disabled).toBe(false);
  });
});
