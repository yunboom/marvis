import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "@marvis/core/api";
import type { KbJob } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { KbJobsPage } from "./kb-jobs-page";

vi.mock("@marvis/core/api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      getKnowledgeBase: vi.fn(),
      listKnowledgeBaseJobs: vi.fn(),
      setKnowledgeBaseJobArchived: vi.fn(),
      deleteKnowledgeBaseJob: vi.fn(),
    },
  };
});

vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="avatar">{actorId}</span>,
}));

vi.mock("../../layout/page-header", () => ({
  PageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

const mocked = vi.mocked(api);

function job(over: Partial<KbJob>): KbJob {
  return {
    id: "job-1",
    knowledge_base_id: "kb-1",
    name: "处理批注",
    starter: "annotations",
    agent_id: "agent-1",
    agent_name: "通用开发助手",
    chat_session_id: "chat-1",
    draft_id: null,
    created_by: "user-1",
    state: "idle",
    archived: false,
    last_reply: "",
    draft: null,
    merge_request: null,
    annotation_ids: [],
    page_id: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const ACTIVE = job({ id: "job-active", name: "Active job" });
const ARCHIVED = job({ id: "job-archived", name: "Archived job", archived: true });

function mount() {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/kb/team/jobs",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <KbJobsPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

function row(name: string) {
  return screen.getByText(name).closest("li") as HTMLElement;
}

async function openArchivedView() {
  mount();
  await screen.findByText("Active job");
  await userEvent.click(screen.getByRole("button", { name: /^Archived/ }));
  await screen.findByText("Archived job");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getKnowledgeBase.mockResolvedValue({ name: "Team", slug: "team" } as never);
  mocked.listKnowledgeBaseJobs.mockResolvedValue([ACTIVE, ARCHIVED]);
});

describe("KbJobsPage loading", () => {
  it("draws row skeletons, not the empty state, while the jobs load", () => {
    mocked.listKnowledgeBaseJobs.mockReturnValue(new Promise(() => {}));
    mount();

    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText("No jobs yet")).toBeNull();
  });
});

describe("KbJobsPage archive", () => {
  it("keeps archived jobs out of the main view and offers only archive there", async () => {
    mount();
    await screen.findByText("Active job");

    expect(screen.queryByText("Archived job")).toBeNull();
    const active = row("Active job");
    expect(within(active).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(active).queryByRole("button", { name: "Delete" })).toBeNull();

    mocked.setKnowledgeBaseJobArchived.mockResolvedValue({ ...ACTIVE, archived: true });
    await userEvent.click(within(active).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocked.setKnowledgeBaseJobArchived).toHaveBeenCalledWith("job-active", true));
  });

  it("offers unarchive and delete in the archived view", async () => {
    await openArchivedView();

    expect(screen.queryByText("Active job")).toBeNull();
    const archived = row("Archived job");
    expect(within(archived).queryByRole("button", { name: "Archive" })).toBeNull();

    mocked.setKnowledgeBaseJobArchived.mockResolvedValue({ ...ARCHIVED, archived: false });
    await userEvent.click(within(archived).getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(mocked.setKnowledgeBaseJobArchived).toHaveBeenCalledWith("job-archived", false));
  });

  it("deletes only after the inline confirm", async () => {
    await openArchivedView();
    const archived = row("Archived job");

    await userEvent.click(within(archived).getByRole("button", { name: "Delete" }));
    expect(mocked.deleteKnowledgeBaseJob).not.toHaveBeenCalled();
    await userEvent.click(within(archived).getByRole("button", { name: "Cancel" }));
    expect(mocked.deleteKnowledgeBaseJob).not.toHaveBeenCalled();

    mocked.deleteKnowledgeBaseJob.mockResolvedValue(undefined);
    await userEvent.click(within(row("Archived job")).getByRole("button", { name: "Delete" }));
    const confirmRow = row("Archived job");
    const buttons = within(confirmRow).getAllByRole("button", { name: "Delete" });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(mocked.deleteKnowledgeBaseJob).toHaveBeenCalledWith("job-archived"));
  });
});
