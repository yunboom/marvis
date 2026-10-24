// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };
const PATH = "team/wiki/concepts/refund.md";

const apiMock = vi.hoisted(() => ({
  createKnowledgeAnnotation: vi.fn(() => Promise.resolve(null)),
  updateKnowledgeAnnotation: vi.fn(() => Promise.resolve()),
}));
const annotationsRef = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@marvis/core/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/knowledge")>()),
  knowledgePageListOptions: () => ({
    queryKey: ["pages"],
    queryFn: () =>
      Promise.resolve({
        commit: "c1",
        pages: [{ path: PATH, group: "concepts", title: "Refunds", type: "concept", domains: [], verified: false, needs_check: false, open_annotations: 0, agent_findings: 0 }],
      }),
  }),
  knowledgePageOptions: () => ({
    queryKey: ["page"],
    queryFn: () =>
      Promise.resolve({
        commit: "c1",
        path: PATH,
        group: "concepts",
        title: "Refunds",
        front_matter: { type: "concept", description: "", domains: [], verified: null, status: "", stale_after: "" },
        needs_check: false,
        sections: [{ heading: "Rules", paragraphs: [[{ text: "Return first.", cites: [] }, { text: "Refunds settle next day.", cites: [] }, { text: "Fees apply.", cites: [] }]] }],
        sources: [],
        backlinks: [],
        markdown: "",
      }),
  }),
  knowledgeAnnotationListOptions: () => ({ queryKey: ["annotations"], queryFn: () => Promise.resolve(annotationsRef.current) }),
}));

import { KnowledgeAnnotationsTab } from "./knowledge-annotations";
import { KnowledgePagesWorkspace } from "./knowledge-pages-workspace";

const kb = { id: "kb-1", workspace_id: "ws-1", name: "Team", slug: "team", description: "", maintainer_agent_id: null, created_by: "", page_count: 1, created_at: "", updated_at: "" };

function renderWith(node: React.ReactNode) {
  const navigation: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/knowledge",
    searchParams: new URLSearchParams(`page=${PATH}`),
    hash: "",
    getShareableUrl: (p) => p,
  };
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NavigationProvider value={navigation}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
      </NavigationProvider>
    </I18nProvider>,
  );
}

const annotation = (over: Record<string, unknown>) => ({
  id: "a1",
  knowledge_base_id: "kb-1",
  page_path: PATH,
  page_title: "Refunds",
  quote: "Refunds settle next day.",
  body: "Explain why",
  author_type: "member",
  author_id: "u1",
  author_name: "Ana",
  status: "pending",
  change_request_id: null,
  change_number: null,
  anchor_lost: false,
  created_at: "2026-10-25T08:00:00Z",
  ...over,
});

describe("knowledge annotations", () => {
  beforeEach(() => {
    annotationsRef.current = [];
    vi.clearAllMocks();
  });

  it("annotates a clicked sentence with its neighbours as anchor", async () => {
    const submit = vi.fn();
    renderWith(<KnowledgePagesWorkspace kb={kb} onOpenChange={vi.fn()} onSubmitAnnotations={submit} />);
    await userEvent.click(await screen.findByRole("button", { name: "Refunds settle next day." }));
    await userEvent.type(screen.getByLabelText("Annotation"), "Explain why");
    await userEvent.click(screen.getByRole("button", { name: "Add annotation" }));
    await waitFor(() =>
      expect(apiMock.createKnowledgeAnnotation).toHaveBeenCalledWith("kb-1", {
        page_path: PATH,
        body: "Explain why",
        quote: "Refunds settle next day.",
        prefix: "Return first.",
        suffix: "Fees apply.",
      }),
    );
  });

  it("lists open annotations in the rail and offers to send pending ones", async () => {
    annotationsRef.current = [annotation({}), annotation({ id: "a2", anchor_lost: true, body: "Old sentence" })];
    const submit = vi.fn();
    renderWith(<KnowledgePagesWorkspace kb={kb} onOpenChange={vi.fn()} onSubmitAnnotations={submit} />);
    const rail = await screen.findByRole("complementary", { name: "Annotations on this page" });
    expect(await within(rail).findByText("Explain why")).toBeTruthy();
    expect(within(rail).getByText("The sentence changed and can't be found. Kept as a page annotation.")).toBeTruthy();
    await userEvent.click(within(rail).getByRole("button", { name: "Send 2 to the agent" }));
    expect(submit).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "a1" })]));
  });

  it("dismisses a pending annotation from the tab", async () => {
    annotationsRef.current = [annotation({})];
    renderWith(<KnowledgeAnnotationsTab kb={kb} onOpenPage={vi.fn()} onOpenChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(apiMock.updateKnowledgeAnnotation).toHaveBeenCalledWith("a1", "dismissed"));
  });
});
