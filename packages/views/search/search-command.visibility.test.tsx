import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { buildIssueStatusCatalog } from "@marvis/core/issue-statuses/queries";
import { useInboxUnreadCount } from "@marvis/core/inbox/queries";
import { onInboxSummaryInvalidate } from "@marvis/core/inbox/ws-updaters";
import { createQueryClient } from "@marvis/core/query-client";
import { SearchCommand } from "./search-command";
import { useSearchStore } from "./search-store";
import enSearch from "../locales/en/search.json";
import enLayout from "../locales/en/layout.json";
import enProjects from "../locales/en/projects.json";

const { getInboxUnreadSummary } = vi.hoisted(() => ({
  getInboxUnreadSummary: vi.fn(),
}));

vi.mock("@marvis/core/api", () => ({
  api: {
    getBaseUrl: () => "http://localhost",
    getInboxUnreadSummary,
    listWorkspaces: async () => [],
    listMembers: async () => [],
  },
}));

vi.mock("@marvis/core", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => buildIssueStatusCatalog([]),
}));
vi.mock("@marvis/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("ws-test") };
});
vi.mock("../navigation/context", () => {
  const adapter = () => ({
    push: vi.fn(),
    pathname: "/ws-test/issues",
    getShareableUrl: (path: string) => path,
  });
  return { useNavigation: adapter, useOptionalNavigation: adapter };
});
vi.mock("@marvis/ui/components/common/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

function SidebarCount() {
  const count = useInboxUnreadCount("ws-1");
  return <output aria-label="Inbox unread count">{count}</output>;
}

beforeEach(() => {
  getInboxUnreadSummary.mockReset().mockResolvedValue([{ workspace_id: "ws-1", count: 1 }]);
  useSearchStore.setState({ open: false });
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
});

it("a closed, mounted search palette defers hidden inbox events alongside the sidebar", async () => {
  const qc = createQueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { search: enSearch, layout: enLayout, projects: enProjects } }}>
        <SidebarCount />
        <SearchCommand />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("Inbox unread count")).toHaveTextContent("1"));
  expect(getInboxUnreadSummary).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await act(async () => { focusManager.setFocused(false); });
  getInboxUnreadSummary.mockResolvedValue([{ workspace_id: "ws-1", count: 4 }]);
  await act(async () => {
    for (let i = 0; i < 3; i++) await onInboxSummaryInvalidate(qc);
  });
  expect(getInboxUnreadSummary).toHaveBeenCalledTimes(1);

  await act(async () => { focusManager.setFocused(true); });
  await waitFor(() => expect(screen.getByLabelText("Inbox unread count")).toHaveTextContent("4"));
  expect(getInboxUnreadSummary).toHaveBeenCalledTimes(2);

  view.unmount();
  qc.clear();
});
