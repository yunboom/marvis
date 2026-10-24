// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import type { KnowledgeBase } from "@marvis/core/knowledge";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

const graph = {
  nodes: [
    { path: "team/wiki/entities/payment.md", title: "Payment", group: "entities", degree: 2 },
    { path: "team/wiki/concepts/refund.md", title: "Refund", group: "concepts", degree: 1 },
    { path: "team/wiki/howtos/deploy.md", title: "Deploy", group: "howtos", degree: 1 },
    { path: "team/wiki/queries/lonely.md", title: "Lonely", group: "queries", degree: 0 },
  ],
  edges: [
    { from: "team/wiki/concepts/refund.md", to: "team/wiki/entities/payment.md" },
    { from: "team/wiki/howtos/deploy.md", to: "team/wiki/entities/payment.md" },
  ],
};

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgeGraphOptions: () => ({ queryKey: ["graph"], queryFn: () => Promise.resolve(graph) }),
}));

import { KnowledgeGraphTab } from "./knowledge-graph-tab";

const kb = { id: "kb-1", slug: "team", name: "Team" } as KnowledgeBase;

function renderTab(onOpenPage = vi.fn()) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <KnowledgeGraphTab kb={kb} onOpenPage={onOpenPage} />
      </QueryClientProvider>
    </I18nProvider>,
  );

  return onOpenPage;
}

describe("KnowledgeGraphTab", () => {
  it("opens a page on click and on Enter", async () => {
    const onOpenPage = renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Open Refund" }));
    expect(onOpenPage).toHaveBeenCalledWith("team/wiki/concepts/refund.md");

    screen.getByRole("button", { name: "Open Lonely" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenPage).toHaveBeenCalledWith("team/wiki/queries/lonely.md");
  });

  it("dims pages that are not linked to the hovered one", async () => {
    renderTab();
    await userEvent.hover(await screen.findByRole("button", { name: "Open Refund" }));
    expect(screen.getByRole("button", { name: "Open Deploy" }).getAttribute("class")).toContain("opacity-25");
    expect(screen.getByRole("button", { name: "Open Payment" }).getAttribute("class")).toContain("opacity-100");
  });

  it("draws orphan pages dashed and lists the groups present", async () => {
    renderTab();
    const lonely = await screen.findByRole("button", { name: "Open Lonely" });
    expect(lonely.querySelector("circle")?.getAttribute("stroke-dasharray")).toBe("3 2");
    expect(screen.getByText("Entities")).toBeTruthy();
    expect(screen.getByText("No links")).toBeTruthy();
    expect(screen.queryByText("Decisions")).toBeNull();
  });
});
