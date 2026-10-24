// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgePageListOptions: () => ({
    queryKey: ["pages"],
    queryFn: () =>
      Promise.resolve({
        commit: "c1",
        pages: [
          { path: "team/wiki/entities/pay.md", group: "entities", title: "Payments", type: "entity", domains: ["dev"], verified: true, needs_check: false, open_annotations: 2, agent_findings: 1 },
          { path: "team/wiki/howtos/release.md", group: "howtos", title: "Release", type: "howto", domains: ["qa"], verified: false, needs_check: false, open_annotations: 0, agent_findings: 0 },
        ],
      }),
  }),
  knowledgePageOptions: (_ws: string, _kb: string, path: string | null) => ({
    queryKey: ["page", path],
    queryFn: () =>
      Promise.resolve({
        commit: "c1",
        path: "team/wiki/entities/pay.md",
        group: "entities",
        title: "Payments",
        front_matter: { type: "entity", description: "", domains: ["dev"], verified: { by: "Ana", at: "2026-10-20" }, status: "", stale_after: "" },
        needs_check: false,
        sections: [{ heading: "Callbacks", paragraphs: [[{ text: "Callbacks are deduplicated.", cites: [1, 2] }]] }],
        sources: [
          { n: 1, kind: "task", uri: "task://MAR-1", label: "Callback rework", chat: null },
          { n: 2, kind: "chat", uri: "", label: "", chat: { owner_name: "Zhang", agent_name: "Marvis", created_at: "2026-10-24T00:00:00Z", openable: false } },
        ],
        backlinks: [{ path: "team/wiki/entities/order.md", title: "Orders" }],
        markdown: "",
      }),
    enabled: !!path,
  }),
}));

import { KnowledgePagesTab } from "./knowledge-pages-tab";

function renderTab() {
  const navigation: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/knowledge",
    searchParams: new URLSearchParams("page=team/wiki/entities/pay.md"),
    hash: "",
    getShareableUrl: (p) => p,
  };
  const kb = { id: "kb-1", workspace_id: "ws-1", name: "Team", slug: "team", description: "", maintainer_agent_id: null, created_by: "", page_count: 2, created_at: "", updated_at: "" };
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NavigationProvider value={navigation}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <KnowledgePagesTab kb={kb} />
        </QueryClientProvider>
      </NavigationProvider>
    </I18nProvider>,
  );
}

describe("KnowledgePagesTab", () => {
  it("groups the tree and reads the selected page with its sources", async () => {
    renderTab();
    expect(await screen.findByText("Callbacks are deduplicated.")).toBeTruthy();
    const tree = screen.getByRole("navigation", { name: "Pages" });
    expect(within(tree).getByText("Entities")).toBeTruthy();
    expect(within(tree).getByText("How-tos")).toBeTruthy();
    expect(screen.getByText("Verified · Ana · 2026-10-20")).toBeTruthy();
    expect(screen.getByText("Callback rework")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Orders" })).toBeTruthy();
  });

  it("shows another member's chat source without a way to open it", async () => {
    renderTab();
    expect(await screen.findByText("Zhang's chat with Marvis · 2026-10-24")).toBeTruthy();
    expect(screen.getByText("Only its owner can open it")).toBeTruthy();
  });
});
