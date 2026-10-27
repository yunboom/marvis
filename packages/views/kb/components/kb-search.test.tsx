import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@marvis/core/api";
import type { KbSearchHit, KbSearchResult } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbSearchBox, highlightTerms } from "./kb-search";

vi.mock("@marvis/core/api", () => ({
  api: { searchKnowledgeBases: vi.fn() },
}));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

const mocked = vi.mocked(api);

function hit(overrides: Partial<KbSearchHit>): KbSearchHit {
  return {
    page_id: "page-cb",
    slug: "team",
    path: "/payment/callback",
    parents: ["产品与业务", "支付"],
    title: "支付回调",
    type: "Workflow",
    block_id: "b4",
    excerpt: "渠道回调按订单号加幂等键去重，重复回调直接返回成功。",
    score: 0.03,
    mention: "",
    ...overrides,
  };
}

const RESULT: KbSearchResult = {
  mode: "hybrid",
  total: 3,
  hits: [
    hit({}),
    hit({ page_id: "page-key", title: "幂等键", block_id: "", excerpt: "回调和下单接口都依赖它去重。" }),
    hit({ page_id: "page-reg", title: "回归清单", parents: [], excerpt: "回调重复投递要验证订单状态。" }),
  ],
};

function mount() {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/kb/team",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbSearchBox kbSlug="team" />
      </NavigationProvider>
    </QueryClientProvider>,
    { locale: "zh-Hans" },
  );

  return adapter;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KbSearchBox", () => {
  it("lists hits with their location and links to the matching block", async () => {
    mocked.searchKnowledgeBases.mockResolvedValue(RESULT);
    mount();

    await userEvent.type(screen.getByRole("searchbox", { name: "在本知识库搜索" }), "回调 去重");

    expect(await screen.findByText("3 个页面")).toBeInTheDocument();
    expect(mocked.searchKnowledgeBases).toHaveBeenLastCalledWith({ q: "回调 去重", kb: "team", type: undefined, limit: 10 });

    const first = screen.getByRole("link", { name: /^支付回调/ });
    expect(first).toHaveAttribute("href", "/acme/kb/team/p/page-cb#b4");
    expect(first).toHaveTextContent("产品与业务 / 支付");
    // A title-only hit links to the page itself.
    expect(screen.getByRole("link", { name: /^幂等键/ })).toHaveAttribute("href", "/acme/kb/team/p/page-key");
    expect(screen.getAllByText("回调", { selector: "b" }).length).toBeGreaterThan(0);
  });

  it("says so when nothing is found", async () => {
    mocked.searchKnowledgeBases.mockResolvedValue({ mode: "keyword", total: 0, hits: [] });
    mount();

    await userEvent.type(screen.getByRole("searchbox"), "渠道限流阈值");

    expect(await screen.findByText("没有找到「渠道限流阈值」")).toBeInTheDocument();
    expect(screen.getByText("换个关键词试试。")).toBeInTheDocument();
  });

  it("opens the first hit on Enter and closes on Escape", async () => {
    mocked.searchKnowledgeBases.mockResolvedValue(RESULT);
    const adapter = mount();
    const box = screen.getByRole("searchbox");

    await userEvent.type(box, "回调");
    await screen.findByText("3 个页面");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("3 个页面")).not.toBeInTheDocument();

    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(adapter.push).toHaveBeenCalledWith("/acme/kb/team/p/page-cb#b4"));
  });

  it("does not search an empty query", async () => {
    mount();

    await userEvent.type(screen.getByRole("searchbox"), "   ");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(mocked.searchKnowledgeBases).not.toHaveBeenCalled();
  });
});

describe("highlightTerms", () => {
  it("bolds every term, case-insensitive, and escapes regex characters", () => {
    const parts = highlightTerms("Retry (twice) then retry", "retry (twice)");
    const bold = parts.filter((part) => typeof part !== "string");
    expect(bold).toHaveLength(3);
  });
});
