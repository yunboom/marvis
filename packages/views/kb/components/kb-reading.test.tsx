import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import type { KbHome, KbPage, KbRevision, KbTreeLevel, KbTreePage, KnowledgeBaseDetail } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbHomePage } from "./kb-home-page";
import { KbPageView } from "./kb-page-view";
import { KbRevisionDiffPage } from "./kb-revision-diff-page";
import { KbShell } from "./kb-shell";

vi.mock("@marvis/core/api", () => ({
  api: {
    listKnowledgeBases: vi.fn(),
    getKnowledgeBase: vi.fn(),
    getKnowledgeBaseHome: vi.fn(),
    listKnowledgeBasePages: vi.fn(),
    getKnowledgeBasePage: vi.fn(),
    listKnowledgeBasePageHistory: vi.fn(),
    getKnowledgeBaseRevisionDiff: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/auth", () => {
  const state = { user: { id: "user-1" } };
  const useAuthStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getMemberName: (id: string) => (id === "user-1" ? "王芳" : "Unknown") }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ name }: { name?: string }) => <span data-testid="avatar">{name}</span>,
}));

// Markdown rendering is RichContent's own concern; this stand-in renders
// links and inline HTML so the page's own wiring can be exercised.
vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => (
    <div
      data-testid="rich"
      dangerouslySetInnerHTML={{ __html: content.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>') }}
    />
  ),
}));

const mocked = vi.mocked(api);

const BASE: KnowledgeBaseDetail = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "团队知识库",
  slug: "team",
  description: "订单、支付、发布与测试流程",
  schema_mode: "default",
  created_by: "user-1",
  page_count: 3,
  content_version: 9,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  pending: { annotations: 4, stale_pages: 2, open_mrs: 1 },
  purpose: "",
  schema: "",
};

function treePage(overrides: Partial<KbTreePage>): KbTreePage {
  return {
    id: "p",
    path: "/p",
    title: "P",
    type: "Guide",
    description: "",
    has_child: false,
    child_count: 0,
    stale: false,
    open_annotations: 0,
    draft_change: "",
    ...overrides,
  };
}

function level(pages: KbTreePage[], nextCursor = ""): KbTreeLevel {
  return { version: 9, parent: null, pages, next_cursor: nextCursor, total: pages.length };
}

const CALLBACK: KbPage = {
  id: "page-cb",
  knowledge_base_id: "kb-1",
  path: "/product/payment/callback",
  version: "rev-2",
  breadcrumb: [
    { id: "page-product", title: "产品与业务" },
    { id: "page-payment", title: "支付" },
  ],
  frontmatter: {
    type: "Workflow",
    title: "支付回调",
    tags: ["开发", "测试"],
    verified: [{ by: "human:user-1", at: "2026-10-20T00:00:00Z" }],
    stale_after: "2027-01-20T00:00:00Z",
  },
  blocks: [
    { id: "b1", kind: "text", content: "## 处理顺序" },
    { id: "b2", kind: "text", content: "渠道回调先经过网关验签。[^spec] 见[幂等键](/kb/team/p/page-idem#b9) 和[退款](/payment/refund.md)。" },
    { id: "b3", kind: "text", content: "## 去重" },
    { id: "b4", kind: "text", content: "渠道回调按订单号加幂等键去重。[^mar-142]" },
    { id: "b5", kind: "text", content: "[^spec]: 渠道接入规范" },
  ],
  sources: [
    {
      id: "spec",
      kind: "raw",
      uri: "raw://sources/channel-v3.pdf#page=12",
      title: "回调签名校验",
      version: "",
      openable: true,
      raw: {
        id: "raw-1",
        name: "渠道接入规范 v3.pdf",
        content_type: "application/pdf",
        size: 100,
        uploaded_by: "user-1",
        created_at: "2026-10-08T00:00:00Z",
        page: 12,
      },
    },
    {
      id: "mar-142",
      kind: "task",
      uri: "task://MAR-142",
      title: "回调改用渠道交易号去重",
      version: "",
      openable: true,
      raw: null,
    },
  ],
  claims: [{ key: "c1", block_id: "b2", text: "渠道回调先经过网关验签。", checked_at: "2026-10-20T00:00:00Z" }],
  last_mr: { number: 15, author_type: "agent", author_id: "agent-1", author_name: "通用开发助手", merged_at: "2026-10-25T00:00:00Z" },
  updated_at: "2026-10-25T00:00:00Z",
  stale: false,
  backlinks: [{ id: "page-idem", title: "幂等键" }],
  pending_mr: { number: 16, title: "去重键改为渠道交易号" },
  pending_mr_count: 1,
  annotations_open: 2,
  draft_change: "",
  drafts: [],
};

function makeAdapter(pathname: string, search = ""): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(search),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function mount(ui: ReactElement, adapter: NavigationAdapter, client = newClient()) {
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
  return { adapter, client };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listKnowledgeBases.mockResolvedValue([BASE]);
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.getKnowledgeBasePage.mockResolvedValue(CALLBACK);
  mocked.listKnowledgeBasePages.mockImplementation(async (_kb, params = {}) => {
    switch (params.parent ?? "") {
      case "":
        return level([
          treePage({ id: "page-product", title: "产品与业务", has_child: true, child_count: 1 }),
          treePage({ id: "page-faq", title: "常见问题" }),
        ]);
      case "page-product":
        return level([treePage({ id: "page-payment", title: "支付", has_child: true, child_count: 1 })]);
      case "page-payment":
        return level([
          treePage({ id: "page-cb", title: "支付回调", stale: true, draft_change: params.draft ? "modified" : "" }),
        ]);
      default:
        return level([]);
    }
  });
});

describe("KbShell page tree", () => {
  it("expands the tree to the page being read and marks it", async () => {
    mount(
      <KbShell>
        <div />
      </KbShell>,
      makeAdapter("/acme/kb/team/p/page-cb"),
    );

    const current = await screen.findByRole("link", { name: "支付回调" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("href", "/acme/kb/team/p/page-cb");
    expect(screen.getByRole("img", { name: "Needs review" })).toBeInTheDocument();
    expect(mocked.listKnowledgeBasePages).toHaveBeenCalledWith("team", expect.objectContaining({ parent: "page-payment" }));
    // Annotations, stale pages and open merge requests of the base.
    expect(screen.getByText("7 pending")).toBeInTheDocument();
  });

  it("loads a level when expanded and collapses it again", async () => {
    mocked.getKnowledgeBasePage.mockResolvedValue({ ...CALLBACK, breadcrumb: [] });
    mount(
      <KbShell>
        <div />
      </KbShell>,
      makeAdapter("/acme/kb/team"),
    );

    const expand = await screen.findByRole("button", { name: "Expand 产品与业务" });
    expect(screen.queryByRole("link", { name: "支付" })).not.toBeInTheDocument();
    await userEvent.click(expand);
    expect(await screen.findByRole("link", { name: "支付" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse 产品与业务" }));
    expect(screen.queryByRole("link", { name: "支付" })).not.toBeInTheDocument();
  });

  it("shows draft labels and keeps the draft on tree links", async () => {
    mount(
      <KbShell>
        <div />
      </KbShell>,
      makeAdapter("/acme/kb/team/p/page-cb", "draft=d-1"),
    );

    const link = await screen.findByRole("link", { name: "支付回调" });
    expect(link).toHaveAttribute("href", "/acme/kb/team/p/page-cb?draft=d-1");
    expect(within(link.parentElement!).getByText("Draft")).toBeInTheDocument();
  });

  it("fetches the next cursor page of a long level", async () => {
    mocked.listKnowledgeBasePages.mockImplementation(async (_kb, params = {}) =>
      params.cursor
        ? level([treePage({ id: "late", title: "Late page" })])
        : level([treePage({ id: "early", title: "Early page" })], "cursor-2"),
    );
    mount(
      <KbShell>
        <div />
      </KbShell>,
      makeAdapter("/acme/kb/team"),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Late page" })).toBeInTheDocument();
    expect(mocked.listKnowledgeBasePages).toHaveBeenCalledWith("team", expect.objectContaining({ cursor: "cursor-2" }));
  });
});

describe("KbPageView", () => {
  it("renders the page with citations, inert unwritten links and banners", async () => {
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    expect(await screen.findByRole("heading", { level: 1, name: "支付回调" })).toBeInTheDocument();
    expect(screen.getByText(/Updated by 通用开发助手/)).toBeInTheDocument();
    expect(screen.getByText(/Verified · 王芳/)).toBeInTheDocument();
    expect(screen.getByText(/1 change to this page is waiting for review: 去重键改为渠道交易号 \(#16\)/)).toBeInTheDocument();

    const cite = screen.getByRole("link", { name: "1" });
    expect(cite).toHaveAttribute("href", "#kb-cite-spec");
    expect(screen.getByRole("link", { name: "退款" })).toHaveAttribute("href", "#kb-missing");
    expect(screen.getByRole("link", { name: "幂等键" })).toHaveAttribute("href", "/kb/team/p/page-idem#b9");
    // Footnote definition blocks are not shown; the sources list replaces them.
    expect(screen.queryByText(/渠道接入规范$/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\[1\] File · 渠道接入规范 v3\.pdf/ })).toBeInTheDocument();
  });

  it("shows a raw file citation on hover and opens it through the callback", async () => {
    const open = vi.fn();
    mount(<KbPageView rawFileActions={{ open, download: vi.fn() }} />, makeAdapter("/acme/kb/team/p/page-cb"));

    const cite = await screen.findByRole("link", { name: "1" });
    fireEvent.mouseOver(cite);
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText("渠道接入规范 v3.pdf")).toBeInTheDocument();
    expect(within(card).getByText(/Page 12 · 回调签名校验/)).toBeInTheDocument();
    expect(within(card).getByText(/Uploaded · 王芳/)).toBeInTheDocument();

    await userEvent.click(within(card).getByRole("button", { name: "Open file" }));
    expect(open).toHaveBeenCalledWith(CALLBACK.sources[0]!.raw);
  });

  it("opens an issue citation in the app on click", async () => {
    const { adapter } = mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    fireEvent.click(await screen.findByRole("link", { name: "2" }));
    expect(adapter.push).toHaveBeenCalledWith("/acme/issues/MAR-142");
  });

  it("highlights claims of a page past its review date", async () => {
    mocked.getKnowledgeBasePage.mockResolvedValue({ ...CALLBACK, stale: true });
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    const mark = await screen.findByText("渠道回调先经过网关验签。");
    expect(mark.tagName).toBe("MARK");
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
  });

  it("opens the info, contents and history panels", async () => {
    mocked.listKnowledgeBasePageHistory.mockResolvedValue([revision({ current: true })]);
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    await userEvent.click(await screen.findByRole("button", { name: "Page info" }));
    const info = screen.getByRole("complementary", { name: "Page info" });
    expect(within(info).getByText("王芳 · verified " + new Date("2026-10-20T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
    expect(within(info).getByRole("link", { name: "幂等键" })).toHaveAttribute("href", "/acme/kb/team/p/page-idem");
    expect(within(info).getByText("开发")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));
    const toc = screen.getByRole("complementary", { name: "Contents" });
    expect(within(within(toc).getByRole("navigation")).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "处理顺序",
      "去重",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Page history" }));
    const history = await screen.findByRole("link", { name: /#9处理批注/ });
    expect(history).toHaveAttribute("href", "/acme/kb/team/p/page-cb/history/rev-9");
    expect(screen.getByText("Current version")).toBeInTheDocument();
  });

  it("switches between the published page and the viewer's drafts", async () => {
    const drafts = [
      { id: "d-1", title: "", status: "open", updated_at: new Date().toISOString(), draft_change: "modified", changed_blocks: 1, origin: { type: "chat", label: "回调去重键", ref_id: "s-1" } },
      { id: "d-2", title: "", status: "open", updated_at: new Date().toISOString(), draft_change: "modified", changed_blocks: 2, origin: { type: "issue", label: "回调重试次数", ref_id: "150" } },
    ];
    mocked.getKnowledgeBasePage.mockImplementation(async (_ref, draft) =>
      draft
        ? {
            ...CALLBACK,
            version: "d3",
            draft_change: "modified",
            drafts,
            blocks: CALLBACK.blocks.map((b) =>
              b.id === "b4" ? { ...b, content: "渠道回调按渠道交易号加幂等键去重。[^mar-142]" } : b,
            ),
          }
        : { ...CALLBACK, drafts },
    );

    const published = makeAdapter("/acme/kb/team/p/page-cb");
    mount(<KbPageView />, published);
    expect(await screen.findByText(/You have 2 drafts changing this page/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Draft" }));
    expect(published.replace).toHaveBeenCalledWith("/acme/kb/team/p/page-cb?draft=d-1");
  });

  it("shows a draft's edits inline against the published page", async () => {
    mocked.getKnowledgeBasePage.mockImplementation(async (_ref, draft) =>
      draft
        ? {
            ...CALLBACK,
            draft_change: "modified",
            blocks: CALLBACK.blocks.map((b) =>
              b.id === "b4" ? { ...b, content: "渠道回调按渠道交易号加幂等键去重。[^mar-142]" } : b,
            ),
            drafts: [
              { id: "d-1", title: "", status: "open", updated_at: new Date().toISOString(), draft_change: "modified", changed_blocks: 1, origin: { type: "chat", label: "回调去重键", ref_id: "s-1" } },
              { id: "d-2", title: "", status: "open", updated_at: new Date().toISOString(), draft_change: "modified", changed_blocks: 2, origin: { type: "issue", label: "回调重试次数", ref_id: "150" } },
            ],
          }
        : CALLBACK,
    );

    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb", "draft=d-2"));
    expect(await screen.findByText("渠道交易")).toHaveProperty("tagName", "INS");
    expect(screen.getByText("订单")).toHaveProperty("tagName", "DEL");
    expect(screen.getByRole("button", { name: "Draft" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Choose draft" }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Chat “回调去重键”"),
      expect.stringContaining("Issue “回调重试次数”"),
    ]);
    expect(items[1]).toHaveAttribute("aria-checked", "true");
  });

  it("reports a missing page", async () => {
    mocked.getKnowledgeBasePage.mockRejectedValue(new Error("404"));
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/gone"));

    expect(await screen.findByText("This page does not exist or was deleted")).toBeInTheDocument();
  });
});

function revision(overrides: Partial<KbRevision>): KbRevision {
  return {
    revision_id: "rev-9",
    mr_number: 9,
    mr_title: "处理批注：补查间隔",
    source: "annotations",
    author_type: "agent",
    author_id: "agent-1",
    author_name: "通用开发助手",
    merged_by: "user-1",
    merged_by_name: "王芳",
    merged_at: "2026-10-19T00:00:00Z",
    annotations: 1,
    added: 1,
    deleted: 1,
    current: false,
    ...overrides,
  };
}

describe("KbHomePage", () => {
  const home: KbHome = {
    knowledge_base: BASE,
    pending: { annotations: 4, agent_reported: 1, stale_pages: 2, open_mrs: 3, latest_mr: { number: 16, title: "去重键改为渠道交易号" } },
    recent: [{ page_id: "page-cb", path: "/product/payment/callback", title: "支付回调", mr_number: 14, mr_title: "每日知识沉淀", merged_at: new Date().toISOString() }],
    running_jobs: 0,
  };

  it("renders the overview: pending work and recent pages", async () => {
    mocked.getKnowledgeBaseHome.mockResolvedValue(home);
    mount(<KbHomePage />, makeAdapter("/acme/kb/team"));

    expect(await screen.findByRole("heading", { level: 1, name: "团队知识库" })).toBeInTheDocument();
    expect(screen.getByText("Latest: 去重键改为渠道交易号")).toBeInTheDocument();
    expect(screen.getByText("Includes 1 gap reported by agents")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /支付回调/ })).toHaveAttribute("href", "/acme/kb/team/p/page-cb");
    expect(screen.getByText("#14 每日知识沉淀")).toBeInTheDocument();
  });

  it("shows the onboarding guide right after creation and dismisses it", async () => {
    mocked.getKnowledgeBaseHome.mockResolvedValue(home);
    const { adapter } = mount(<KbHomePage />, makeAdapter("/acme/kb/team", "welcome=1"));

    expect(await screen.findByText("Knowledge base “团队知识库” has been created. Here is how to use it.")).toBeInTheDocument();
    expect(screen.getByText("Ingest sources")).toBeInTheDocument();
    expect(screen.getByText("Suggested first")).toBeInTheDocument();
    expect(screen.getByText("Scheduled maintenance")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(adapter.replace).toHaveBeenCalledWith("/acme/kb/team");
  });

  it("offers configuration in the knowledge base menu to its creator", async () => {
    mocked.getKnowledgeBaseHome.mockResolvedValue(home);
    mount(
      <KbShell>
        <span />
      </KbShell>,
      makeAdapter("/acme/kb/team"),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Knowledge base actions" }));
    expect(await screen.findByRole("menuitem", { name: /Configure knowledge base/ })).toHaveAttribute(
      "href",
      "/acme/kb/team/config",
    );
  });

  it("reports a missing knowledge base", async () => {
    mocked.getKnowledgeBaseHome.mockRejectedValue(new Error("404"));
    mount(<KbHomePage />, makeAdapter("/acme/kb/gone"));

    expect(await screen.findByText("This knowledge base does not exist or was deleted")).toBeInTheDocument();
  });
});

describe("KbRevisionDiffPage", () => {
  it("shows the revision's hunks with the history beside them", async () => {
    mocked.listKnowledgeBasePageHistory.mockResolvedValue([
      revision({ revision_id: "rev-14", mr_number: 14, mr_title: "每日收录", current: true }),
      revision({}),
      revision({ revision_id: "rev-0", mr_number: null, mr_title: "" }),
    ]);
    mocked.getKnowledgeBaseRevisionDiff.mockResolvedValue({
      revision: revision({}),
      prev_revision_id: "rev-6",
      hunks: [
        {
          heading: "处理顺序",
          lines: [
            { op: "equal", old_line: 9, new_line: 9, text: "支付服务按支付单加锁处理。" },
            { op: "deleted", old_line: 10, new_line: 0, text: "每 30 分钟补查一次。" },
            { op: "added", old_line: 0, new_line: 10, text: "每 10 分钟补查一次。[^2]" },
          ],
        },
      ],
    });

    await act(async () => {
      mount(<KbRevisionDiffPage />, makeAdapter("/acme/kb/team/p/page-cb/history/rev-9"));
    });

    expect(await screen.findByText("#9 处理批注：补查间隔")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("处理顺序")).toBeInTheDocument();
    expect(screen.getByText("每 30 分钟补查一次。").closest("[data-op]")).toHaveAttribute("data-op", "deleted");
    expect(screen.getByText("每 10 分钟补查一次。[^2]").closest("[data-op]")).toHaveAttribute("data-op", "added");
    expect(screen.getByText("1 annotation handled", { exact: false })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Initial version/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /#9处理批注/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Close history" })).toHaveAttribute("href", "/acme/kb/team/p/page-cb");
  });
});
