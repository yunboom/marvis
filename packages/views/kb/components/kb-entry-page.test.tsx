import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import { useKbLastOpenedStore } from "@marvis/core/kb";
import type { KnowledgeBase } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbEntryPage } from "./kb-entry-page";

vi.mock("@marvis/core/api", () => ({
  api: { listKnowledgeBases: vi.fn() },
}));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

const listKnowledgeBases = vi.mocked(api.listKnowledgeBases);

function makeBase(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: "kb-1",
    workspace_id: "ws-1",
    name: "Team handbook",
    slug: "team",
    description: "",
    schema_mode: "default",
    created_by: "user-1",
    page_count: 0,
    content_version: 0,
    created_at: "2026-10-02T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
    ...overrides,
  };
}

const TEAM = makeBase({});
const PAYMENTS = makeBase({ id: "kb-2", name: "Payments", slug: "payments", created_at: "2026-10-01T00:00:00Z" });

function mount(): NavigationAdapter {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/kb",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbEntryPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );

  return adapter;
}

beforeEach(() => {
  listKnowledgeBases.mockReset();
  useKbLastOpenedStore.setState({ byWorkspace: {} });
});

describe("KbEntryPage", () => {
  it("opens the knowledge base last opened in the workspace", async () => {
    listKnowledgeBases.mockResolvedValue([TEAM, PAYMENTS]);
    useKbLastOpenedStore.setState({ byWorkspace: { "ws-1": "kb-1" } });

    const adapter = mount();

    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team"));
    expect(adapter.replace).toHaveBeenCalledTimes(1);
  });

  it("falls back to the earliest created knowledge base when the last opened one is gone", async () => {
    listKnowledgeBases.mockResolvedValue([TEAM, PAYMENTS]);
    useKbLastOpenedStore.setState({ byWorkspace: { "ws-1": "kb-deleted" } });

    const adapter = mount();

    await waitFor(() => expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/payments"));
  });

  it("shows the empty state with a create link when the workspace has no knowledge base", async () => {
    listKnowledgeBases.mockResolvedValue([]);

    const adapter = mount();

    const create = await screen.findByRole("link", { name: "New knowledge base" });
    expect(create).toHaveAttribute("href", "/acme/kb/new");
    expect(adapter.replace).not.toHaveBeenCalled();
  });
});
