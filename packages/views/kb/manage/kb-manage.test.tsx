import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "@marvis/core/api";
import type { KbGraph, KbPage, KbRawFileItem, KnowledgeBaseDetail, MemberWithUser } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbPageView } from "../components/kb-page-view";
import { KbGraphPage } from "./kb-graph-page";
import { KbManagePage } from "./kb-manage-page";
import { parseKbRawHref } from "./use-kb-raw-files";

const tryOpen = vi.fn(() => true);
const toastError = vi.fn();

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (message: string) => toastError(message) } }));

vi.mock("@marvis/core/api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public statusText: string,
      public body: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      listKnowledgeBases: vi.fn(),
      getKnowledgeBase: vi.fn(),
      listKnowledgeBaseRawFiles: vi.fn(),
      uploadKnowledgeBaseRawFiles: vi.fn(),
      getKnowledgeBaseRawFileUrl: vi.fn(),
      exportKnowledgeBase: vi.fn(),
      deleteKnowledgeBase: vi.fn(),
      getKnowledgeBaseGraph: vi.fn(),
      getKnowledgeBasePage: vi.fn(),
      listKnowledgeBaseAnnotations: vi.fn().mockResolvedValue([]),
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
  useActorName: () => ({ getMemberName: () => "王芳" }),
}));

// The attachment viewer is the editor's own concern; only what it is asked
// to open matters here.
vi.mock("../../editor", () => ({
  useAttachmentPreview: () => ({ tryOpen, open: vi.fn(), modal: null }),
}));

vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => (
    <div dangerouslySetInnerHTML={{ __html: content.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>') }} />
  ),
}));

const mocked = vi.mocked(api);

const BASE: KnowledgeBaseDetail = {
  id: "kb-1",
  workspace_id: "ws-1",
  name: "团队知识库",
  slug: "team",
  description: "",
  schema_mode: "default",
  created_by: "user-2",
  page_count: 3,
  content_version: 9,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  pending: { annotations: 4, stale_pages: 0, open_mrs: 2 },
  purpose: "",
  schema: "",
};

const SPEC: KbRawFileItem = {
  id: "raw-1",
  kind: "source",
  name: "渠道接入规范 v3.pdf",
  uri: "raw://sources/渠道接入规范 v3.pdf",
  content_type: "application/pdf",
  size: 482113,
  uploaded_by: "user-1",
  uploaded_by_name: "王芳",
  created_at: "2026-10-08T10:12:00Z",
  cited_pages: 3,
};

const NOTES: KbRawFileItem = { ...SPEC, id: "raw-2", name: "notes.md", uri: "raw://sources/notes.md", content_type: "text/markdown", cited_pages: 0 };

function member(role: string): MemberWithUser {
  return { user_id: "user-1", role } as MemberWithUser;
}

function makeAdapter(pathname: string): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function mount(ui: ReactElement, pathname: string) {
  const adapter = makeAdapter(pathname);
  renderWithI18n(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
  return adapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  tryOpen.mockReturnValue(true);
  mocked.listKnowledgeBases.mockResolvedValue([BASE]);
  mocked.getKnowledgeBase.mockResolvedValue(BASE);
  mocked.listMembers.mockResolvedValue([member("member")]);
  mocked.listKnowledgeBaseRawFiles.mockResolvedValue([SPEC, NOTES]);
  mocked.getKnowledgeBaseRawFileUrl.mockResolvedValue("https://signed.example/raw-1");
});

describe("raw files tab", () => {
  it("lists files with uploader and citing pages, and opens a row in the preview", async () => {
    mount(<KbManagePage />, "/acme/kb/team/manage");

    const table = await screen.findByRole("table", { name: "Raw files" });
    expect(await within(table).findAllByText("Uploaded · 王芳")).toHaveLength(2);
    expect(within(table).getByText("3 pages")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open 渠道接入规范 v3.pdf" }));
    await waitFor(() => expect(tryOpen).toHaveBeenCalledWith({ kind: "url", url: "https://signed.example/raw-1", filename: "渠道接入规范 v3.pdf" }));
    expect(mocked.getKnowledgeBaseRawFileUrl).toHaveBeenCalledWith("raw-1");
  });

  it("downloads a file the viewer cannot show", async () => {
    tryOpen.mockReturnValue(false);
    mount(<KbManagePage />, "/acme/kb/team/manage");

    await userEvent.click(await screen.findByRole("button", { name: "Open notes.md" }));
    await waitFor(() => expect(mocked.getKnowledgeBaseRawFileUrl).toHaveBeenCalledWith("raw-2", { download: true }));
  });

  it("uploads files, selects them and hands them to an ingest job", async () => {
    mocked.uploadKnowledgeBaseRawFiles.mockResolvedValue([{ id: "raw-1", kind: "source", name: SPEC.name, uri: SPEC.uri, size: 1 }]);
    const adapter = mount(<KbManagePage />, "/acme/kb/team/manage");
    await screen.findByRole("table", { name: "Raw files" });

    const file = new File(["%PDF"], SPEC.name, { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("kb-raw-input"), { target: { files: [file] } });
    await waitFor(() => expect(mocked.uploadKnowledgeBaseRawFiles).toHaveBeenCalledWith("team", [file], undefined));

    await userEvent.click(await screen.findByRole("button", { name: "Hand to an agent to ingest (1)" }));
    expect(adapter.push).toHaveBeenCalledWith(
      `/acme/kb/team/jobs/new?starter=ingest&sources=${encodeURIComponent(SPEC.uri).replace(/%20/g, "+")}`,
    );
  });

  it("names the taken files when an upload is refused", async () => {
    const { ApiError } = await import("@marvis/core/api");
    mocked.uploadKnowledgeBaseRawFiles.mockRejectedValue(
      new ApiError("taken", 409, "Conflict", { code: "raw_name_taken", names: ["notes.md"] }),
    );
    mount(<KbManagePage />, "/acme/kb/team/manage");
    await screen.findByRole("table", { name: "Raw files" });

    fireEvent.change(screen.getByTestId("kb-raw-input"), { target: { files: [new File(["x"], "notes.md")] } });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("A file with this name exists: notes.md"));
  });
});

describe("export and delete tabs", () => {
  it("shows delete only to the creator or an owner / admin", async () => {
    mount(<KbManagePage />, "/acme/kb/team/manage");
    await screen.findByRole("link", { name: "Export" });
    expect(screen.queryByRole("link", { name: "Delete knowledge base" })).not.toBeInTheDocument();
  });

  it("exports the bundle as a zip", async () => {
    mocked.exportKnowledgeBase.mockResolvedValue(new Blob(["zip"]));
    const createObjectURL = vi.fn(() => "blob:zip");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    mount(<KbManagePage />, "/acme/kb/team/manage/export");

    await userEvent.click(await screen.findByRole("button", { name: "Export zip" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(mocked.exportKnowledgeBase).toHaveBeenCalledWith("team");
  });

  it("deletes after the name is typed, then leaves for the list", async () => {
    mocked.listMembers.mockResolvedValue([member("admin")]);
    mocked.deleteKnowledgeBase.mockResolvedValue({ deleted: true, closed_mrs: [16] });
    const adapter = mount(<KbManagePage />, "/acme/kb/team/manage/delete");

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/closes its 4 annotations and 2 pending changes/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByRole("textbox"), "团队知识库");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => expect(mocked.deleteKnowledgeBase).toHaveBeenCalledWith("team", "团队知识库"));
    await waitFor(() => expect(adapter.push).toHaveBeenCalledWith("/acme/kb"));
  });
});

describe("graph", () => {
  const GRAPH: KbGraph = {
    nodes: [
      { key: "p1", id: "p1", title: "支付回调", path: "/payment/callback", group: "支付", degree: 2, missing: false },
      { key: "p2", id: "p2", title: "幂等键", path: "/payment/idem", group: "支付", degree: 1, missing: false },
      { key: "/payment/refund", id: null, title: "/payment/refund", path: "/payment/refund", group: "支付", degree: 1, missing: true },
      { key: "p3", id: "p3", title: "测试环境", path: "/testing/env", group: "测试", degree: 0, missing: false },
    ],
    edges: [
      { from: "p1", to: "p2" },
      { from: "p1", to: "/payment/refund" },
    ],
  };

  it("draws groups, highlights neighbours on hover and opens pages", async () => {
    mocked.getKnowledgeBaseGraph.mockResolvedValue(GRAPH);
    const adapter = mount(<KbGraphPage />, "/acme/kb/team/graph");

    const callback = await screen.findByRole("link", { name: "Open 支付回调 · 2 links" });
    expect(screen.getAllByTestId("kb-graph-node")).toHaveLength(4);
    expect(screen.getByText("测试", { selector: "span" })).toBeInTheDocument();

    fireEvent.mouseEnter(callback);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open 支付回调 · 2 links");
    expect(screen.getByRole("link", { name: "Open 测试环境 · 0 links" })).toHaveAttribute("opacity", "0.22");
    expect(screen.getByRole("link", { name: "Open 幂等键 · 1 link" })).toHaveAttribute("opacity", "1");

    fireEvent.click(callback);
    expect(adapter.push).toHaveBeenCalledWith("/acme/kb/team/p/p1");
    // A page not yet written has nothing to open.
    expect(screen.getByLabelText("/payment/refund · not written yet")).not.toHaveAttribute("role");
  });
});

describe("raw links on the reading page", () => {
  it("parses routed raw links", () => {
    expect(parseKbRawHref("/api/kb/raw/raw-1/content#page=3")).toEqual({ id: "raw-1", page: 3 });
    expect(parseKbRawHref("https://api.example/api/kb/raw/raw-1/content")).toEqual({ id: "raw-1", page: 0 });
    expect(parseKbRawHref("/kb/team/p/page-1")).toBeNull();
  });

  it("opens a raw link of the body in the preview on the cited page", async () => {
    const page = {
      id: "page-1",
      knowledge_base_id: "kb-1",
      path: "/p",
      version: "rev-1",
      breadcrumb: [],
      frontmatter: { title: "P" },
      blocks: [{ id: "b1", kind: "text", content: "见[规范](/api/kb/raw/raw-1/content#page=3)。" }],
      sources: [],
      claims: [],
      last_mr: null,
      updated_at: "",
      stale: false,
      backlinks: [],
      pending_mr: null,
      pending_mr_count: 0,
      pending_mrs: [],
      annotations_open: 0,
      draft_change: "",
      drafts: [],
    } as unknown as KbPage;
    mocked.getKnowledgeBasePage.mockResolvedValue(page);
    mount(<KbPageView />, "/acme/kb/team/p/page-1");

    fireEvent.click(await screen.findByRole("link", { name: "规范" }));
    await waitFor(() =>
      expect(tryOpen).toHaveBeenCalledWith({ kind: "url", url: "https://signed.example/raw-1#page=3", filename: SPEC.name }),
    );
  });
});
