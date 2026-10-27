import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import type { KbAnnotation, KbHome, KbPage, KnowledgeBaseDetail } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbAnnotationComposer, KbAnnotationsPage, readSelectedSentence } from "./kb-annotations";
import { KbHomePage } from "./kb-home-page";
import { KbPageView } from "./kb-page-view";

vi.mock("@marvis/core/api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly statusText: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      getKnowledgeBase: vi.fn(),
      getKnowledgeBaseHome: vi.fn(),
      getKnowledgeBasePage: vi.fn(),
      listKnowledgeBaseAnnotations: vi.fn(),
      createKnowledgeBaseAnnotation: vi.fn(),
      updateKnowledgeBaseAnnotation: vi.fn(),
      listMembers: vi.fn(),
    },
  };
});

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
  useActorName: () => ({ getMemberName: () => "Unknown" }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ name }: { name?: string }) => <span data-testid="avatar">{name}</span>,
}));

vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => (
    <div
      data-testid="rich"
      dangerouslySetInnerHTML={{ __html: content.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>') }}
    />
  ),
}));

const mocked = vi.mocked(api);

// The viewer (user-1) is a plain member; the knowledge base belongs to someone else.
const BASE: KnowledgeBaseDetail = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "团队知识库",
  slug: "team",
  description: "",
  schema_mode: "default",
  created_by: "user-9",
  page_count: 1,
  content_version: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  pending: { annotations: 2, stale_pages: 0, open_mrs: 0 },
  purpose: "",
  schema: "",
};

function annotation(overrides: Partial<KbAnnotation>): KbAnnotation {
  return {
    id: "a",
    knowledge_base_id: "kb-1",
    page_id: "page-cb",
    page_path: "/payment/callback",
    page_title: "支付回调",
    block_id: "b4",
    block_index: 2,
    quote: "渠道回调按订单号加幂等键去重。",
    original_quote: "",
    prefix: "",
    suffix: "",
    body: "去重键已经改成渠道交易号。",
    author_type: "member",
    author_id: "user-1",
    author_name: "王芳",
    status: "pending",
    anchor_lost: false,
    merge_request_id: null,
    mr_number: null,
    created_at: "2026-10-24T17:40:00Z",
    updated_at: "2026-10-24T17:40:00Z",
    mention: "",
    ...overrides,
  };
}

const MINE = annotation({ id: "a-mine" });
const FOLLOWED = annotation({
  id: "a-followed",
  author_id: "user-2",
  author_name: "韩梅梅",
  quote: "原路退款在次日 02:00 批量提交渠道。",
  original_quote: "原路退款在次日批量提交渠道。",
  body: "补充一下为什么不实时提交。",
});
const LOST = annotation({
  id: "a-lost",
  author_id: "user-3",
  author_name: "李雷",
  block_id: "",
  block_index: 0,
  quote: "灰度比例为 10% → 50% → 100%。",
  anchor_lost: true,
  body: "灰度比例写错了。",
});
const WHOLE = annotation({
  id: "a-kb",
  page_id: null,
  page_path: "",
  page_title: "",
  block_id: "",
  block_index: 0,
  quote: "",
  author_type: "agent",
  author_id: "agent-1",
  author_name: "通用开发助手",
  body: "知识库里没有渠道限流阈值。",
});
const PROCESSING = annotation({ id: "a-mr", status: "processing", merge_request_id: "mr-1", mr_number: 16, body: "处理中" });
const DISMISSED = annotation({ id: "a-off", status: "dismissed", body: "不用管" });

const PAGE: KbPage = {
  id: "page-cb",
  knowledge_base_id: "kb-1",
  path: "/payment/callback",
  version: "rev-1",
  breadcrumb: [],
  frontmatter: { type: "Workflow", title: "支付回调" },
  blocks: [
    { id: "b3", kind: "text", content: "## 去重" },
    { id: "b4", kind: "text", content: "渠道回调按订单号加幂等键去重。[^mar-142] 幂等键保存 24 小时。" },
  ],
  sources: [{ id: "mar-142", kind: "task", uri: "task://MAR-142", title: "去重", version: "", openable: true, raw: null }],
  claims: [],
  last_mr: null,
  updated_at: "2026-10-25T00:00:00Z",
  stale: false,
  backlinks: [],
  pending_mr: null,
  pending_mr_count: 0,
  pending_mrs: [],
  annotations_open: 1,
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

function mount(ui: ReactElement, adapter: NavigationAdapter) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.getKnowledgeBasePage.mockResolvedValue(PAGE);
  mocked.listMembers.mockResolvedValue([{ user_id: "user-1", role: "member" }] as never);
  mocked.listKnowledgeBaseAnnotations.mockResolvedValue([]);
  mocked.createKnowledgeBaseAnnotation.mockImplementation(async (_kb, data) => annotation({ id: "a-new", ...data }));
  mocked.updateKnowledgeBaseAnnotation.mockImplementation(async (id, data) => annotation({ id, status: data.status }));
});

describe("KbAnnotationsPage", () => {
  beforeEach(() => {
    mocked.listKnowledgeBaseAnnotations.mockResolvedValue([MINE, FOLLOWED, LOST, WHOLE, PROCESSING, DISMISSED]);
  });

  it("lists pending annotations with where they sit and how they followed the page", async () => {
    const adapter = makeAdapter("/acme/kb/team/annotations");
    mount(<KbAnnotationsPage />, adapter);

    expect(await screen.findByText("去重键已经改成渠道交易号。")).toBeInTheDocument();
    expect(mocked.listKnowledgeBaseAnnotations).toHaveBeenCalledWith("team", { status: "all", page: undefined });
    expect(screen.getByRole("tab", { name: /Pending\s*4/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /In progress\s*1/ })).toBeInTheDocument();

    // Handing every pending annotation to an agent opens a new job with them
    // brought in and the request written out.
    await userEvent.click(screen.getByRole("button", { name: "Hand all to an agent (4)" }));
    const target = new URL(vi.mocked(adapter.push).mock.calls[0]![0], "https://app.example");
    expect(target.pathname).toBe("/acme/kb/team/jobs/new");
    expect(target.searchParams.get("starter")).toBe("annotations");
    expect(target.searchParams.get("annotations")?.split(",").sort()).toEqual(["a-followed", "a-kb", "a-lost", "a-mine"]);
    expect(target.searchParams.get("message")).toBe("Handle all 4 pending annotations in 团队知识库.");

    const mine = screen.getByText("去重键已经改成渠道交易号。").closest("li")!;
    expect(within(mine).getByRole("link", { name: "支付回调 · paragraph 2" })).toHaveAttribute(
      "href",
      "/acme/kb/team/p/page-cb#b4",
    );
    expect(within(mine).getByText("渠道回调按订单号加幂等键去重。")).toBeInTheDocument();

    const followed = screen.getByText("补充一下为什么不实时提交。").closest("li")!;
    expect(within(followed).getByText("Followed a rewrite")).toBeInTheDocument();
    expect(within(followed).getByText("Sentence when annotated: 原路退款在次日批量提交渠道。")).toBeInTheDocument();

    const lost = screen.getByText("灰度比例写错了。").closest("li")!;
    expect(within(lost).getByText("Sentence deleted")).toBeInTheDocument();
    expect(within(lost).getByRole("link", { name: "支付回调 · whole page" })).toHaveAttribute("href", "/acme/kb/team/p/page-cb");
    expect(within(lost).getByText("Sentence when annotated: 灰度比例为 10% → 50% → 100%。")).toBeInTheDocument();
    expect(within(lost).queryByText("灰度比例为 10% → 50% → 100%。")).not.toBeInTheDocument();

    expect(within(screen.getByText("知识库里没有渠道限流阈值。").closest("li")!).getByText("Whole knowledge base")).toBeInTheDocument();
  });

  it("lets the author dismiss and reopen, and nobody else", async () => {
    mount(<KbAnnotationsPage />, makeAdapter("/acme/kb/team/annotations"));

    const mine = (await screen.findByText("去重键已经改成渠道交易号。")).closest("li")!;
    expect(within(screen.getByText("补充一下为什么不实时提交。").closest("li")!).queryByRole("button")).toBeNull();

    await userEvent.click(within(mine).getByRole("button", { name: "Dismiss" }));
    expect(mocked.updateKnowledgeBaseAnnotation).toHaveBeenCalledWith("a-mine", { status: "dismissed" });

    await userEvent.click(screen.getByRole("tab", { name: "Dismissed" }));
    const dismissed = screen.getByText("不用管").closest("li")!;
    await userEvent.click(within(dismissed).getByRole("button", { name: "Reopen" }));
    expect(mocked.updateKnowledgeBaseAnnotation).toHaveBeenCalledWith("a-off", { status: "pending" });

    await userEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    const processing = screen.getByText("处理中", { selector: "div" }).closest("li")!;
    expect(within(processing).getByText("#16")).toBeInTheDocument();
    expect(within(processing).queryByRole("button")).toBeNull();
  });
});

describe("page annotations", () => {
  it("opens the page panel and adds a page annotation", async () => {
    mocked.listKnowledgeBaseAnnotations.mockResolvedValue([MINE, DISMISSED]);
    const adapter = makeAdapter("/acme/kb/team/p/page-cb");
    mount(<KbPageView />, adapter);

    await userEvent.click(await screen.findByRole("button", { name: "Page annotations" }));
    const panel = await screen.findByRole("complementary", { name: "Page annotations 1" });
    expect(mocked.listKnowledgeBaseAnnotations).toHaveBeenCalledWith("team", { status: "all", page: "page-cb" });
    expect(within(panel).getByText("去重键已经改成渠道交易号。")).toBeInTheDocument();
    expect(within(panel).queryByText("不用管")).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Hand off to an agent" }));
    expect(adapter.push).toHaveBeenCalledWith(
      "/acme/kb/team/jobs/new?starter=annotations&annotations=a-mine&message=" +
        encodeURIComponent("Handle the 1 pending annotation on “支付回调”.").replace(/%20/g, "+"),
    );
    // The annotated sentence is marked on the page while the panel is open.
    await waitFor(() => expect(document.querySelector("[data-block-id='b4'] mark")?.textContent).toBe("渠道回调按订单号加幂等键去重。"));

    await userEvent.click(within(panel).getByRole("button", { name: "Add annotation" }));
    await userEvent.type(within(panel).getByRole("textbox", { name: "Annotate this page" }), "整页都需要复核");
    await userEvent.click(within(panel).getByRole("button", { name: "Annotate" }));
    expect(mocked.createKnowledgeBaseAnnotation).toHaveBeenCalledWith("team", { page_id: "page-cb", body: "整页都需要复核" });
  });

  it("underlines sentences with open annotations without opening the panel", async () => {
    const resolved = annotation({ id: "a-done", status: "resolved", quote: "幂等键保存 24 小时。", body: "已处理" });
    const lost = annotation({ id: "a-gone", anchor_lost: true, quote: "幂等键保存 24 小时。", body: "原句没了" });
    mocked.listKnowledgeBaseAnnotations.mockResolvedValue([MINE, resolved, lost, DISMISSED]);
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    await waitFor(() => expect(document.querySelectorAll("[data-block-id='b4'] mark.kb-annotated")).toHaveLength(1));
    const mark = document.querySelector("[data-block-id='b4'] mark.kb-annotated")!;
    expect(mark.textContent).toBe("渠道回调按订单号加幂等键去重。");
    expect(mark.getAttribute("data-annotation-ids")).toBe("a-mine");
    expect(screen.queryByRole("complementary", { name: /Page annotations/ })).not.toBeInTheDocument();
  });

  it("does not fetch annotations for a page without open ones", async () => {
    mocked.getKnowledgeBasePage.mockResolvedValue({ ...PAGE, annotations_open: 0 });
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    await screen.findByRole("heading", { level: 1, name: "支付回调" });
    expect(mocked.listKnowledgeBaseAnnotations).not.toHaveBeenCalled();
    expect(document.querySelector("mark.kb-annotated")).toBeNull();
  });

  it("opens the panel on the annotations of a clicked sentence and scrolls to the earliest", async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const earlier = annotation({ id: "a-early", author_id: "user-2", body: "更早的一条", created_at: "2026-10-24T09:00:00Z" });
    const other = annotation({ id: "a-other", quote: "幂等键保存 24 小时。", body: "另一句" });
    mocked.listKnowledgeBaseAnnotations.mockResolvedValue([MINE, earlier, other]);
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    await waitFor(() => expect(document.querySelectorAll("mark.kb-annotated")).toHaveLength(2));
    const mark = document.querySelector<HTMLElement>("mark[data-annotation-ids='a-mine,a-early']")!;
    await userEvent.click(mark);

    const panel = await screen.findByRole("complementary", { name: "Page annotations 3" });
    const card = (body: string) => within(panel).getByRole("article", { name: body });
    expect(card("去重键已经改成渠道交易号。")).toHaveAttribute("aria-current", "true");
    expect(card("更早的一条")).toHaveAttribute("aria-current", "true");
    expect(card("另一句")).not.toHaveAttribute("aria-current");
    await waitFor(() => expect(scrolled.at(-1)).toBe(card("更早的一条")));

    // Clicking again keeps the panel open and scrolls to it again.
    const calls = scrollIntoView.mock.calls.length;
    await userEvent.click(document.querySelector<HTMLElement>("mark[data-annotation-ids='a-mine,a-early']")!);
    expect(screen.getByRole("complementary", { name: "Page annotations 3" })).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoView.mock.calls.length).toBeGreaterThan(calls));
    expect(scrolled.at(-1)).toBe(card("更早的一条"));
  });

  it("annotates a selected sentence", async () => {
    mount(<KbPageView />, makeAdapter("/acme/kb/team/p/page-cb"));

    await screen.findByRole("heading", { level: 1, name: "支付回调" });
    const block = document.querySelector<HTMLElement>("[data-block-id='b4']")!;
    const text = block.querySelector("[data-testid='rich']")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "渠道回调按订单号加幂等键去重。".length);
    act(() => {
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    fireEvent.mouseUp(block);

    await userEvent.click(await screen.findByRole("button", { name: "Annotate" }));
    const dialog = screen.getByRole("dialog", { name: "Annotation" });
    expect(within(dialog).getByText("Agents see this sentence when they handle it")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox"), "去重键已改");
    await userEvent.click(within(dialog).getByRole("button", { name: "Annotate" }));

    expect(mocked.createKnowledgeBaseAnnotation).toHaveBeenCalledWith("team", {
      page_id: "page-cb",
      block_id: "b4",
      quote: "渠道回调按订单号加幂等键去重。",
      body: "去重键已改",
    });
    // The page panel opens on the new annotation.
    expect(await screen.findByRole("complementary", { name: /Page annotations/ })).toBeInTheDocument();
  });
});

describe("KbAnnotationComposer keyboard", () => {
  function renderComposer(pending = false) {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderWithI18n(<KbAnnotationComposer label="Annotation" pending={pending} onSubmit={onSubmit} onCancel={onCancel} />);

    return { onSubmit, onCancel, box: screen.getByRole("textbox", { name: "Annotation" }) };
  }

  it("submits on Enter and breaks the line on Shift+Enter", async () => {
    const { onSubmit, box } = renderComposer();

    await userEvent.type(box, "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(box).toHaveValue("第一行\n第二行");
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("第一行\n第二行");
  });

  it("does not submit an empty body", async () => {
    const empty = renderComposer();
    await userEvent.type(empty.box, "  {Enter}");
    expect(empty.onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while a submit is pending", async () => {
    const busy = renderComposer(true);
    await userEvent.type(busy.box, "内容{Enter}");
    expect(busy.onSubmit).not.toHaveBeenCalled();
  });

  it("ignores the Enter that confirms an input method composition", () => {
    const { onSubmit, box } = renderComposer();
    fireEvent.change(box, { target: { value: "huifu" } });

    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const { onCancel, box } = renderComposer();

    await userEvent.type(box, "草稿{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("readSelectedSentence", () => {
  it("reads one block's text without citation markers", () => {
    document.body.innerHTML = `
      <div id="root">
        <div data-block-id="b1" data-change="same"><p>按订单号<a href="#kb-cite-x">1</a>去重。</p></div>
        <div data-block-id="b2" data-change="added"><p>新内容</p></div>
      </div>`;
    const root = document.getElementById("root")!;
    const paragraph = root.querySelector("[data-block-id='b1'] p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readSelectedSentence(root, selection)).toEqual({ blockId: "b1", quote: "按订单号去重。" });

    // Across blocks, or inside a draft's edit, is not a sentence.
    const across = document.createRange();
    across.setStart(paragraph, 0);
    across.setEnd(root.querySelector("[data-block-id='b2'] p")!, 1);
    selection.removeAllRanges();
    selection.addRange(across);
    expect(readSelectedSentence(root, selection)).toBeNull();

    const added = document.createRange();
    added.selectNodeContents(root.querySelector("[data-block-id='b2'] p")!);
    selection.removeAllRanges();
    selection.addRange(added);
    expect(readSelectedSentence(root, selection)).toBeNull();
  });
});

describe("KbHomePage annotations", () => {
  it("links the pending card to the list and opens the knowledge base panel", async () => {
    const home: KbHome = {
      knowledge_base: BASE,
      pending: { annotations: 2, agent_reported: 1, stale_pages: 0, open_mrs: 0, latest_mr: null },
      recent: [],
      running_jobs: 0,
    };
    mocked.getKnowledgeBaseHome.mockResolvedValue(home);
    mocked.listKnowledgeBaseAnnotations.mockResolvedValue([WHOLE]);
    mount(<KbHomePage />, makeAdapter("/acme/kb/team"));

    expect(await screen.findByRole("link", { name: /Annotations/ })).toHaveAttribute("href", "/acme/kb/team/annotations");
    expect(mocked.listKnowledgeBaseAnnotations).toHaveBeenCalledWith("team", { status: "all", page: "-" });

    await userEvent.click(screen.getByRole("button", { name: "Knowledge base annotations" }));
    const panel = await screen.findByRole("complementary", { name: "Knowledge base annotations 1" });
    expect(within(panel).getByText("知识库里没有渠道限流阈值。")).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Add annotation" }));
    await userEvent.type(within(panel).getByRole("textbox", { name: "Annotate the whole knowledge base" }), "缺少回滚步骤");
    await userEvent.click(within(panel).getByRole("button", { name: "Annotate" }));
    expect(mocked.createKnowledgeBaseAnnotation).toHaveBeenCalledWith("team", { body: "缺少回滚步骤" });
  });
});
