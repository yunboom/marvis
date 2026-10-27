import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ApiError, api } from "@marvis/core/api";
import type { KbAnnotation, KbMergeRequestDetail, KbPage, KnowledgeBase } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbMention, splitKbPageMention } from "./kb-mention-cards";

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
      listKnowledgeBases: vi.fn(),
      getKnowledgeBasePage: vi.fn(),
      getKnowledgeBaseMergeRequest: vi.fn(),
      getKnowledgeBaseAnnotation: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({ getMemberName: () => "木卫五" }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ name }: { name?: string }) => <span data-testid="avatar">{name}</span>,
}));

const mocked = vi.mocked(api);

const BASE: KnowledgeBase = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "支付排障手册",
  slug: "pay-troubleshoot",
  description: "支付、订单链路与排障步骤，给研发和测试用。",
  schema_mode: "default",
  created_by: "user-9",
  page_count: 0,
  content_version: 0,
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
};

const PAGE: KbPage = {
  id: "page-cb",
  knowledge_base_id: "kb-1",
  path: "/payment/callback",
  version: "rev-1",
  breadcrumb: [
    { id: "page-pay", title: "支付" },
    { id: "page-cb", title: "支付回调" },
  ],
  frontmatter: { title: "支付回调", type: "howto", stale_after: "2027-01-20" },
  blocks: [
    { id: "b1", kind: "heading", content: "# 支付回调" },
    { id: "b2", kind: "heading", content: "## 去重" },
    { id: "b3", kind: "paragraph", content: "渠道回调按**渠道交易号**加幂等键去重。[^mar-142]" },
  ],
  sources: [],
  claims: [
    { key: "c1", block_id: "b3", text: "", checked_at: "" },
    { key: "c2", block_id: "b3", text: "", checked_at: "" },
    { key: "c3", block_id: "b3", text: "", checked_at: "" },
  ],
  last_mr: { number: 15, author_type: "member", author_id: "u-2", author_name: "韩梅梅", merged_at: "2026-10-24T00:00:00Z" },
  updated_at: "2026-10-24T00:00:00Z",
  stale: false,
  backlinks: [],
  pending_mr: null,
  pending_mr_count: 0,
  annotations_open: 2,
  draft_change: "",
  drafts: [],
};

const MR = {
  id: "mr-1",
  number: 16,
  knowledge_base_id: "kb-1",
  knowledge_base_slug: "team",
  knowledge_base_name: "团队知识库",
  title: "去重键改为渠道交易号",
  summary: "按 MAR-142 把去重键改为渠道交易号。",
  source: "",
  status: "open",
  risk: "medium",
  author_type: "agent",
  author_id: "agent-1",
  author_name: "通用开发助手",
  draft_id: "d-1",
  draft_version: 3,
  annotation_ids: [],
  origin: { type: "chat", label: "修正支付回调去重键", ref_id: "chat-1", openable: true },
  job_id: null,
  reverts: null,
  merged_by: null,
  merged_by_name: "",
  merged_at: null,
  closed_by: null,
  closed_by_name: "",
  closed_at: null,
  close_reason: "",
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  mention: "",
  pages: [
    { page_id: "page-cb", path: "/payment/callback", old_path: "", title: "支付回调", change: "modified", added: 12, deleted: 1, lines: [] },
    { page_id: "page-m", path: "/payment/manual", old_path: "", title: "回调人工处理", change: "added", added: 8, deleted: 0, lines: [] },
  ],
  checks: { lint: [], conflicts: [] },
  review_agent: null,
  agent_running: false,
  can_merge: false,
  can_close: false,
  can_revert: false,
} satisfies KbMergeRequestDetail;

const ANNOTATION: KbAnnotation = {
  id: "a-1",
  knowledge_base_id: "kb-1",
  page_id: "page-cb",
  page_path: "/payment/callback",
  page_title: "支付回调",
  block_id: "b3",
  block_index: 3,
  quote: "渠道回调按订单号加幂等键去重。",
  original_quote: "",
  prefix: "",
  suffix: "",
  body: "去重键已经改成渠道交易号（MAR-142），这句是旧的。",
  author_type: "agent",
  author_id: "agent-1",
  author_name: "通用开发助手",
  status: "pending",
  anchor_lost: false,
  merge_request_id: null,
  mr_number: null,
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  mention: "",
};

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/chat",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.example${path}`,
};

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

/** Hovers a chip and waits out the hover card's open delay. */
async function hover(text: string) {
  await userEvent.setup().hover(await screen.findByText(text));
}

const notFound = () => new ApiError("not found", 404, "Not Found");

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listKnowledgeBases.mockResolvedValue([BASE, { ...BASE, id: "kb-2", slug: "team", name: "团队知识库" }]);
  mocked.getKnowledgeBasePage.mockResolvedValue(PAGE);
  mocked.getKnowledgeBaseMergeRequest.mockResolvedValue(MR);
  mocked.getKnowledgeBaseAnnotation.mockResolvedValue(ANNOTATION);
});

describe("splitKbPageMention", () => {
  it("splits the block off a page id", () => {
    expect(splitKbPageMention("page-cb#b3")).toEqual({ pageId: "page-cb", blockId: "b3" });
    expect(splitKbPageMention("page-cb")).toEqual({ pageId: "page-cb", blockId: "" });
  });
});

describe("knowledge base card", () => {
  it("links to the knowledge base home and shows its summary on hover", async () => {
    mount(<KbMention type="kb" id="kb-1" label="支付排障手册" />);

    expect(await screen.findByRole("link")).toHaveAttribute("href", "/acme/kb/pay-troubleshoot");

    await hover("支付排障手册");
    expect(await screen.findByText("Knowledge base · pay-troubleshoot", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("支付、订单链路与排障步骤，给研发和测试用。")).toBeInTheDocument();
    expect(screen.getByText("Default schema")).toBeInTheDocument();
    expect(screen.getByText("Nothing pending")).toBeInTheDocument();
  });

  it("falls back to text when the knowledge base is gone", async () => {
    mount(<KbMention type="kb" id="kb-gone" label="旧知识库" />);

    expect(await screen.findByTestId("kb-mention-fallback")).toHaveTextContent("旧知识库");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("page card", () => {
  it("names the section of a linked block and opens the page at it", async () => {
    mount(<KbMention type="kb_page" id="page-cb#b3" label="支付回调" />);

    expect(await screen.findByRole("link")).toHaveAttribute("href", "/acme/kb/pay-troubleshoot/p/page-cb#b3");
    expect(screen.getByText("› 去重")).toBeInTheDocument();
    expect(mocked.getKnowledgeBasePage).toHaveBeenCalledWith("page-cb", undefined);

    await hover("支付回调");
    expect(await screen.findByText("支付回调 › 去重", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("支付排障手册 / 支付")).toBeInTheDocument();
    expect(screen.getByText("渠道回调按渠道交易号加幂等键去重。")).toBeInTheDocument();
    expect(screen.getByText("3 claims")).toBeInTheDocument();
    expect(screen.getByText("2 open annotations")).toBeInTheDocument();
    expect(screen.getByText("Last change #15")).toBeInTheDocument();
  });

  it("links a whole page without a section", async () => {
    mount(<KbMention type="kb_page" id="page-cb" label="支付回调" />);

    expect(await screen.findByRole("link")).toHaveAttribute("href", "/acme/kb/pay-troubleshoot/p/page-cb");
    expect(screen.queryByText(/›/)).not.toBeInTheDocument();
  });

  it("falls back to text saying a deleted page is gone", async () => {
    mocked.getKnowledgeBasePage.mockRejectedValue(notFound());
    mount(<KbMention type="kb_page" id="page-old#b1" label="旧页面" />);

    const fallback = await screen.findByTestId("kb-mention-fallback");
    expect(fallback).toHaveTextContent("旧页面 · Page deleted");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("falls back to plain text without access", async () => {
    mocked.getKnowledgeBasePage.mockRejectedValue(new ApiError("forbidden", 403, "Forbidden"));
    mount(<KbMention type="kb_page" id="page-x" label="别人的页面" />);

    expect(await screen.findByTestId("kb-mention-fallback")).toHaveTextContent(/^别人的页面$/);
  });
});

describe("merge request card", () => {
  it("links to the review and shows status and size on hover", async () => {
    mount(<KbMention type="kb_mr" id="mr-1" label="#16 去重键…" />);

    expect(await screen.findByRole("link")).toHaveAttribute("href", "/acme/kb/team/reviews/16");
    expect(mocked.getKnowledgeBaseMergeRequest).toHaveBeenCalledWith("mr-1");

    await hover("去重键改为渠道交易号");
    expect(await screen.findByText("#16 · Open", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("+20")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByText("Risk medium")).toBeInTheDocument();
    expect(screen.getByText("From Chat · 修正支付回调去重键")).toBeInTheDocument();
  });

  it("follows the live status", async () => {
    mocked.getKnowledgeBaseMergeRequest.mockResolvedValue({ ...MR, status: "merged" });
    mount(<KbMention type="kb_mr" id="mr-1" label="#16 去重键…" />);

    await screen.findByRole("link");
    await hover("去重键改为渠道交易号");
    expect(await screen.findByText("#16 · Merged", undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it("falls back to text when the request cannot be read", async () => {
    mocked.getKnowledgeBaseMergeRequest.mockRejectedValue(notFound());
    mount(<KbMention type="kb_mr" id="mr-x" label="#9 旧变更" />);

    expect(await screen.findByTestId("kb-mention-fallback")).toHaveTextContent("#9 旧变更");
  });
});

describe("annotation card", () => {
  it("opens the page at the sentence and shows the note on hover", async () => {
    mount(<KbMention type="kb_annotation" id="a-1" label="批注 · 支付回调" />);

    const chip = await screen.findByText(/^支付回调 · 去重键已经改成/);
    expect(chip.closest("a")).toHaveAttribute("href", "/acme/kb/pay-troubleshoot/p/page-cb#b3");

    await hover(chip.textContent ?? "");
    expect(await screen.findByText("Annotation · Pending", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("渠道回调按订单号加幂等键去重。")).toBeInTheDocument();
    expect(screen.getByText("去重键已经改成渠道交易号（MAR-142），这句是旧的。")).toBeInTheDocument();
  });

  it("opens the annotation list for one on the whole knowledge base", async () => {
    mocked.getKnowledgeBaseAnnotation.mockResolvedValue({
      ...ANNOTATION,
      page_id: null,
      page_title: "",
      block_id: "",
      quote: "",
      body: "缺少退款回调的处理",
    });
    mount(<KbMention type="kb_annotation" id="a-2" label="批注" />);

    const chip = await screen.findByText("支付排障手册 · 缺少退款回调的处理");
    expect(chip.closest("a")).toHaveAttribute("href", "/acme/kb/pay-troubleshoot/annotations");
  });

  it("falls back to text when the annotation is gone", async () => {
    mocked.getKnowledgeBaseAnnotation.mockRejectedValue(notFound());
    mount(<KbMention type="kb_annotation" id="a-x" label="批注 · 旧页面" />);

    expect(await screen.findByTestId("kb-mention-fallback")).toHaveTextContent("批注 · 旧页面");
  });
});
