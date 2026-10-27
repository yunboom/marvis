import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import type { KnowledgeBase } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbListPage } from "./kb-list-page";

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn() }));

vi.mock("@marvis/core/api", () => ({
  api: { listKnowledgeBases: vi.fn() },
}));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

vi.mock("@marvis/ui/lib/clipboard", () => ({ copyText }));

const listKnowledgeBases = vi.mocked(api.listKnowledgeBases);

function makeBase(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: "kb-1",
    workspace_id: "ws-1",
    name: "Team handbook",
    slug: "team",
    description: "Order, payment and release processes.",
    schema_mode: "default",
    created_by: "user-1",
    page_count: 23,
    content_version: 4,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    pending: { annotations: 3, stale_pages: 2, open_mrs: 1 },
    ...overrides,
  };
}

const TEAM = makeBase({});
const PAYMENTS = makeBase({
  id: "kb-2",
  name: "Payments",
  slug: "payments",
  description: "Gateway, reconciliation and refunds.",
  page_count: 14,
  updated_at: new Date(Date.now() - 26 * 3600_000).toISOString(),
  pending: { annotations: 1, stale_pages: 0, open_mrs: 2 },
});
const LAB = makeBase({
  id: "kb-3",
  name: "Archive",
  slug: "qa-lab",
  description: "Test design methods.",
  page_count: 9,
  updated_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
  pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
});

function makeAdapter(): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/kb",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function mount(adapter = makeAdapter()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbListPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );

  return adapter;
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('[role="row"]');
  if (!row) throw new Error(`row for ${name} not found`);

  return row as HTMLElement;
}

function bodyRowNames(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

beforeEach(() => {
  listKnowledgeBases.mockReset().mockResolvedValue([TEAM, PAYMENTS, LAB]);
  copyText.mockReset().mockResolvedValue(true);
});

describe("KbListPage", () => {
  it("renders a row per knowledge base with its pending work", async () => {
    mount();

    await screen.findByText("Team handbook");
    const team = rowFor("Team handbook");
    expect(within(team).getByText("team/")).toBeInTheDocument();
    expect(within(team).getByText("23")).toBeInTheDocument();
    expect(within(team).getByText("3 annotations · 2 to re-check")).toBeInTheDocument();
    expect(within(team).getByText("10m ago")).toBeInTheDocument();

    expect(within(rowFor("Payments")).getByText("1 annotation")).toBeInTheDocument();
    expect(within(rowFor("Archive")).getByText("—")).toBeInTheDocument();
  });

  it("shows the base count and total changes waiting for review in the header", async () => {
    mount();

    expect(await screen.findByText("3 changes to review")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Knowledge base" }).parentElement).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: "New knowledge base" })).toHaveAttribute("href", "/acme/kb/new");
  });

  it("opens the reviews of the one knowledge base with changes waiting", async () => {
    listKnowledgeBases.mockResolvedValue([PAYMENTS, LAB]);
    mount();

    expect(await screen.findByRole("link", { name: "2 changes to review" })).toHaveAttribute(
      "href",
      "/acme/kb/payments/reviews",
    );
  });

  it("lists the knowledge bases with changes waiting and opens the one picked", async () => {
    const user = userEvent.setup();
    const adapter = mount();

    await user.click(await screen.findByRole("button", { name: "3 changes to review" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Team handbook1", "Payments2"]);

    await user.click(items[1]!);
    expect(adapter.push).toHaveBeenCalledWith("/acme/kb/payments/reviews");
  });

  it("hides the review tag when nothing is waiting", async () => {
    listKnowledgeBases.mockResolvedValue([LAB]);
    mount();

    await screen.findByText("Archive");
    expect(screen.queryByText(/to review/)).toBeNull();
  });

  it("orders by most recent update, then by name on request", async () => {
    const user = userEvent.setup();
    mount();

    await screen.findByText("Team handbook");
    expect(bodyRowNames()).toEqual(["Team handbook", "Payments", "Archive"]);

    await user.click(screen.getByRole("button", { name: "Recently updated" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Name" }));
    expect(bodyRowNames()).toEqual(["Archive", "Payments", "Team handbook"]);
  });

  it("filters by name, slug and description", async () => {
    mount();
    await screen.findByText("Team handbook");
    const search = screen.getByRole("textbox", { name: "Search knowledge bases" });

    fireEvent.change(search, { target: { value: "refunds" } });
    expect(bodyRowNames()).toEqual(["Payments"]);

    fireEvent.change(search, { target: { value: "QA-LAB" } });
    expect(bodyRowNames()).toEqual(["Archive"]);

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No matching knowledge bases")).toBeInTheDocument();
  });

  it("opens the knowledge base when its row is clicked", async () => {
    const adapter = mount();

    fireEvent.click(await screen.findByText("Payments"));
    expect(adapter.push).toHaveBeenCalledWith("/acme/kb/payments");
  });

  it("copies the knowledge base link from the row menu without opening it", async () => {
    const user = userEvent.setup();
    const adapter = mount();

    await screen.findByText("Payments");
    await user.click(within(rowFor("Payments")).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://app.example/acme/kb/payments"));
    expect(adapter.push).not.toHaveBeenCalled();
  });

  it("shows the empty state when the workspace has no knowledge bases", async () => {
    listKnowledgeBases.mockResolvedValue([]);
    mount();

    expect(await screen.findByText("No knowledge bases yet")).toBeInTheDocument();
    expect(
      screen.getByText("Agents write and maintain pages. Team members read, annotate, and review changes."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "New knowledge base" })).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Search knowledge bases" })).toBeNull();
  });

  it("renders Chinese copy", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <NavigationProvider value={makeAdapter()}>
          <KbListPage />
        </NavigationProvider>
      </QueryClientProvider>,
      { locale: "zh-Hans" },
    );

    expect(await screen.findByText("批注 3 · 待复核 2")).toBeInTheDocument();
    expect(screen.getByText("待审核修改 3")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索知识库和页面...")).toBeInTheDocument();
  });
});
