import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildIssueStatusCatalog } from "@marvis/core/issue-statuses/queries";

vi.mock("@marvis/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => buildIssueStatusCatalog([]),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@marvis/core/api";
import { renderWithI18n } from "../test/i18n";
import { AppSidebar } from "./app-sidebar";

const { appForeground, chatSessions, chatStore, detail, deletePin, invitationApi, knowledgeBases, navigation, pins, sidebarState, summary, workspaces } = vi.hoisted(() => ({
  appForeground: { current: true },
  knowledgeBases: { current: [] as { id: string; pending: { annotations: number; stale_pages: number; open_mrs: number } }[] },
  sidebarState: { setOpenMobile: vi.fn() },
  chatSessions: { current: [] as { id?: string; unread_count?: number }[] },
  chatStore: { current: { activeSessionId: null as string | null, isOpen: false } },
  detail: { current: { isPending: false, isError: false, data: null as unknown, error: null as unknown } },
  deletePin: vi.fn(),
  // Captures the sidebar's invitation accept/decline mutations so the
  // self-heal wiring (error → invalidate the pending list) is observable.
  invitationApi: {
    accept: vi.fn(),
    decline: vi.fn(),
    invalidateQueries: vi.fn(),
    mutations: [] as Array<Record<string, unknown>>,
  },
  navigation: { current: { pathname: "/acme/issues" } },
  summary: { current: [] as { workspace_id: string; count: number }[] },
  workspaces: {
    current: [] as { id: string; name: string; slug: string; avatar_url: string | null }[],
  },
  pins: {
    current: [
      {
        id: "pin-1",
        workspace_id: "ws-1",
        user_id: "user-1",
        item_type: "issue" as const,
        item_id: "issue-1",
        position: 0,
        created_at: "2026-05-06T00:00:00Z",
      },
    ],
  },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn() }),
  verticalListSortingStrategy: vi.fn(),
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
vi.mock("@marvis/ui/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarMenuButton: ({
    children,
    isActive,
    render,
    ...props
  }: {
    children: React.ReactNode;
    isActive?: boolean;
    render?: React.ReactElement<{ href?: string }>;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} type="button" data-active={isActive ? "true" : undefined} data-href={render?.props.href}>
      {children}
    </button>
  ),
  SidebarMenuAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-sub">{children}</div>
  ),
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarMenuSubButton: ({
    children,
    isActive,
    render,
  }: {
    children: React.ReactNode;
    isActive?: boolean;
    render?: React.ReactElement<{ href?: string }>;
  }) => (
    <button type="button" data-active={isActive ? "true" : undefined} data-href={render?.props.href}>
      {children}
    </button>
  ),
  SidebarRail: () => null,
  useSidebar: () => ({ setOpenMobile: sidebarState.setOpenMobile }),
}));
vi.mock("@marvis/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));
vi.mock("@marvis/ui/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleTrigger: () => <button type="button" />,
}));
vi.mock("@marvis/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("../common/use-app-foreground", () => ({
  useAppForeground: () => appForeground.current,
}));
vi.mock("./help-launcher", () => ({
  HelpLauncher: () => <span data-testid="help-launcher" />,
}));
vi.mock("../auth", () => ({ useLogout: () => vi.fn() }));
vi.mock("../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));
vi.mock("../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useNavigation: () => ({ pathname: navigation.current.pathname, push: vi.fn() }),
}));
vi.mock("../projects/components/project-icon", () => ({ ProjectIcon: () => <span /> }));
vi.mock("../workspace/workspace-avatar", () => ({ WorkspaceAvatar: () => <span /> }));
vi.mock("@marvis/ui/components/common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));

vi.mock("@marvis/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
// Callable-store shape (selectorFn + getState) per the repo testing rules.
vi.mock("@marvis/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (state: { activeSessionId: string | null; isOpen: boolean }) => unknown) =>
      selector(chatStore.current),
    { getState: () => chatStore.current },
  ),
}));
vi.mock("@marvis/core/paths", async (importOriginal) => ({
  // Spread the real module so pure helpers (resolveRouteIconName, used by the
  // nav to derive each item's icon from its href) stay intact; only the
  // workspace/context hooks below are stubbed to control routes in tests.
  ...(await importOriginal<typeof import("@marvis/core/paths")>()),
  paths: { workspace: (slug: string) => ({ issues: () => `/${slug}/issues` }) },
  useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
  useWorkspacePaths: () => ({
    inbox: () => "/acme/inbox",
    chat: () => "/acme/chat",
    myIssues: () => "/acme/my-issues",
    issues: () => "/acme/issues",
    projects: () => "/acme/projects",
    workflows: () => "/acme/workflows",
    autopilots: () => "/acme/autopilots",
    agents: () => "/acme/agents",
    squads: () => "/acme/squads",
    kb: () => "/acme/kb",
    usage: () => "/acme/usage",
    runtimes: () => "/acme/runtimes",
    skills: () => "/acme/skills",
    settings: () => "/acme/settings",
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
  }),
}));
vi.mock("@marvis/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marvis/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getBaseUrl: () => "http://127.0.0.1:13840",
      acceptInvitation: invitationApi.accept,
      declineInvitation: invitationApi.decline,
    },
  };
});
vi.mock("@marvis/core/inbox/queries", () => ({
  inboxUnreadSummaryOptions: () => ({ queryKey: ["inbox", "unread-summary"] }),
  inboxUnreadSummaryEnabled: (wsId: string | null) => () => !!wsId,
  // The nav badge and the switcher dot read the SAME cross-workspace summary,
  // so the fixture that drives one drives the other.
  useInboxUnreadCount: (currentWsId: string | null) =>
    summary.current.find((s) => s.workspace_id === currentWsId)?.count ?? 0,
  hasOtherWorkspaceUnread: (
    entries: { workspace_id: string; count: number }[],
    currentWsId: string | null,
  ) => entries.some((s) => s.workspace_id !== currentWsId && s.count > 0),
  unreadWorkspaceIds: (entries: { workspace_id: string; count: number }[]) =>
    new Set(entries.filter((s) => s.count > 0).map((s) => s.workspace_id)),
}));
vi.mock("@marvis/core/issues/queries", () => ({ issueDetailOptions: () => ({ queryKey: ["issue"] }) }));
vi.mock("@marvis/core/issues/stores/create-mode-store", () => ({
  useCreateModeStore: { getState: () => ({ lastMode: "agent" }) },
  openCreateIssueWithPreference: vi.fn(),
}));
vi.mock("@marvis/core/issues/stores/draft-store", () => ({ useIssueDraftStore: () => false }));
vi.mock("@marvis/core/modals", () => ({ useModalStore: { getState: () => ({ modal: null, open: vi.fn() }) } }));
vi.mock("@marvis/core/pins/mutations", () => ({ useDeletePin: () => ({ mutate: deletePin }), useReorderPins: () => ({ mutate: vi.fn() }) }));
vi.mock("@marvis/core/pins/queries", () => ({ pinListOptions: () => ({ queryKey: ["pins"] }) }));
vi.mock("@marvis/core/projects/queries", () => ({ projectDetailOptions: () => ({ queryKey: ["project"] }) }));
vi.mock("@marvis/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  myInvitationListOptions: () => ({ queryKey: ["invitations"] }),
  workspaceKeys: { myInvitations: () => ["invitations"] },
  workspaceListOptions: () => ({ queryKey: ["workspaces"] }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: Record<string, unknown> = {}) => {
    invitationApi.mutations.push(options);
    return { isPending: false, mutate: vi.fn() };
  },
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "pins") return { data: pins.current };
    if (queryKey[0] === "issue") return detail.current;
    if (queryKey[0] === "inbox" && queryKey[1] === "unread-summary") return { data: summary.current };
    if (queryKey[0] === "workspaces") return { data: workspaces.current };
    if (queryKey[0] === "chat" && queryKey[2] === "sessions") return { data: chatSessions.current };
    if (queryKey[0] === "kb" && queryKey[2] === "bases") return { data: knowledgeBases.current };
    return { data: [] };
  },
  useQueryClient: () => ({ fetchQuery: vi.fn(), invalidateQueries: invitationApi.invalidateQueries }),
}));

describe("PinRow", () => {
  beforeEach(() => {
    deletePin.mockReset();
    navigation.current.pathname = "/acme/issues";
    detail.current = { isPending: false, isError: false, data: null, error: null };
    summary.current = [];
    workspaces.current = [];
  });

  it("unpins missing details", async () => {
    detail.current = { isPending: false, isError: true, data: null, error: new ApiError("missing", 404, "Not Found") };
    render(<AppSidebar />);
    await waitFor(() => expect(deletePin).toHaveBeenCalledTimes(1));
  });

  it("ignores non-404 errors", async () => {
    detail.current = { isPending: false, isError: true, data: null, error: new ApiError("error", 500, "Server Error") };
    render(<AppSidebar />);
    await waitFor(() => expect(deletePin).not.toHaveBeenCalled());
  });

  it("renders loaded details", async () => {
    detail.current = { isPending: false, isError: false, data: { identifier: "MUL-123", title: "Keep this pin", status: "todo" }, error: null };
    render(<AppSidebar />);
    expect(await screen.findByText("Keep this pin")).toBeInTheDocument();
    expect(screen.queryByText("MUL-123 Keep this pin")).not.toBeInTheDocument();
  });

  it("does not also highlight the parent workspace nav for an active pin", async () => {
    navigation.current.pathname = "/acme/issues/issue-1";
    detail.current = {
      isPending: false,
      isError: false,
      data: { identifier: "MUL-123", title: "Keep this pin", status: "todo" },
      error: null,
    };

    const { container } = render(<AppSidebar />);

    expect((await screen.findByText("Keep this pin")).closest("button")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(container.querySelector('button[data-href="/acme/issues"]')).not.toHaveAttribute("data-active");
  });

  it("keeps the parent route active until a hidden pin is expanded", () => {
    const originalPins = pins.current;
    pins.current = Array.from({ length: 6 }, (_, index) => ({
      ...originalPins[0]!,
      id: `pin-${index + 1}`,
      item_id: `issue-${index + 1}`,
      position: index,
    }));
    navigation.current.pathname = "/acme/issues/issue-6";
    detail.current = {
      isPending: false,
      isError: false,
      data: { identifier: "MUL-123", title: "Pinned issue", status: "todo" },
      error: null,
    };

    try {
      const { container } = renderWithI18n(<AppSidebar />);
      const parent = () => container.querySelector('button[data-href="/acme/issues"]');
      const lastPin = () => container.querySelector('button[data-href="/acme/issues/issue-6"]');

      expect(lastPin()).not.toBeInTheDocument();
      expect(parent()).toHaveAttribute("data-active", "true");

      fireEvent.click(screen.getByRole("button", { name: "Show 1 more…" }));
      expect(lastPin()).toHaveAttribute("data-active", "true");
      expect(parent()).not.toHaveAttribute("data-active");

      fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
      expect(lastPin()).not.toBeInTheDocument();
      expect(parent()).toHaveAttribute("data-active", "true");
    } finally {
      pins.current = originalPins;
    }
  });
});

// On a phone the sidebar is a Sheet laid over the page, so a nav tap that
// leaves it open renders the destination underneath and reads as a dead tap.
describe("mobile sheet dismissal", () => {
  beforeEach(() => {
    sidebarState.setOpenMobile.mockClear();
    navigation.current = { pathname: "/acme/issues" };
  });

  it("dismisses the sheet once the route changes", () => {
    const { rerender } = render(<AppSidebar />);
    sidebarState.setOpenMobile.mockClear();

    navigation.current = { pathname: "/acme/inbox" };
    rerender(<AppSidebar />);

    expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(false);
  });

  // Closing on `pathname` rather than per-link keeps every route out of the
  // sidebar covered at once — nav groups, pins, and the switcher's own push.
  it("does not re-dismiss while the route holds still", () => {
    const { rerender } = render(<AppSidebar />);
    sidebarState.setOpenMobile.mockClear();

    rerender(<AppSidebar />);

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });
});

describe("workspace-switcher unread dot", () => {
  beforeEach(() => {
    summary.current = [];
    workspaces.current = [];
  });

  // The aggregate switcher dot is the only `.ring-sidebar` span in the tree
  // (DraftDot is null when there's no draft, and there are no invitations).
  const dot = (container: HTMLElement) => container.querySelector("span.bg-brand.ring-sidebar");

  it("shows a dot when another workspace has unread inbox items", () => {
    summary.current = [{ workspace_id: "ws-2", count: 3 }];
    const { container } = render(<AppSidebar />);
    expect(dot(container)).not.toBeNull();
  });

  it("does not show a dot when only the active workspace has unread", () => {
    // Active workspace is ws-1 (see useCurrentWorkspace mock).
    summary.current = [{ workspace_id: "ws-1", count: 3 }];
    const { container } = render(<AppSidebar />);
    expect(dot(container)).toBeNull();
  });

  it("does not show a dot when no workspace has unread", () => {
    summary.current = [];
    const { container } = render(<AppSidebar />);
    expect(dot(container)).toBeNull();
  });
});

describe("message box bell", () => {
  beforeEach(() => {
    summary.current = [];
    workspaces.current = [];
  });

  it("marks the bell when the active workspace has unread items", () => {
    summary.current = [{ workspace_id: "ws-1", count: 2 }];
    render(<AppSidebar />);
    expect(screen.getByTestId("message-box-unread-dot")).toBeInTheDocument();
  });

  // Other workspaces' unread is the switcher's brand dot, not the bell's.
  it("leaves the bell plain when only another workspace has unread", () => {
    summary.current = [{ workspace_id: "ws-2", count: 2 }];
    render(<AppSidebar />);
    expect(screen.queryByTestId("message-box-unread-dot")).toBeNull();
  });

  it("drops the inbox from the nav", () => {
    const { container } = render(<AppSidebar />);
    expect(container.querySelector('[data-href="/acme/inbox"]')).toBeNull();
  });
});

describe("workspace-switcher dropdown per-workspace dot", () => {
  beforeEach(() => {
    summary.current = [];
    // Active workspace is ws-1 (see useCurrentWorkspace mock); "Other" is ws-2.
    workspaces.current = [
      { id: "ws-1", name: "Active WS", slug: "active", avatar_url: null },
      { id: "ws-2", name: "Other WS", slug: "other", avatar_url: null },
    ];
  });

  // Row dots are brand dots WITHOUT the aggregate avatar dot's `ring-sidebar`.
  const rowDots = (container: HTMLElement) =>
    container.querySelectorAll("span.bg-brand:not(.ring-sidebar)");

  it("dots the specific other workspace that has unread", () => {
    summary.current = [{ workspace_id: "ws-2", count: 3 }];
    const { container } = render(<AppSidebar />);
    // Exactly one row dot, sitting right after the "Other WS" name; the active
    // row shows the check, not a dot.
    expect(rowDots(container)).toHaveLength(1);
    expect(screen.getByText("Other WS").nextElementSibling?.className).toContain("bg-brand");
    expect(screen.getByText("Active WS").nextElementSibling?.className ?? "").not.toContain("bg-brand");
  });

  it("does not dot a workspace whose unread count is zero", () => {
    summary.current = [{ workspace_id: "ws-2", count: 0 }];
    const { container } = render(<AppSidebar />);
    expect(rowDots(container)).toHaveLength(0);
  });

  it("never dots the active workspace even when it has unread", () => {
    summary.current = [{ workspace_id: "ws-1", count: 5 }];
    const { container } = render(<AppSidebar />);
    expect(rowDots(container)).toHaveLength(0);
  });
});

describe("navigation item presentation", () => {
  it("keeps Analytics and Settings styled like the other nav items", () => {
    const { container } = render(<AppSidebar />);
    const referenceClassName = container.querySelector(
      'button[data-href="/acme/issues"]',
    )?.className;

    expect(referenceClassName).toBeTruthy();

    for (const href of ["/acme/usage", "/acme/settings"]) {
      expect(container.querySelector(`button[data-href="${href}"]`)?.className).toBe(
        referenceClassName,
      );
    }
  });

  it("nests Workflows under Projects as a second-level row", () => {
    navigation.current = { pathname: "/acme/workflows" };
    const { container } = render(<AppSidebar />);
    const workflows = screen
      .getByTestId("sidebar-menu-sub")
      .querySelector<HTMLElement>('button[data-href="/acme/workflows"]');

    expect(workflows?.dataset.active).toBe("true");
    expect(container.querySelectorAll('button[data-href="/acme/workflows"]')).toHaveLength(1);
    expect(container.querySelector('button[data-href="/acme/projects"]')?.getAttribute("data-active")).toBeNull();
    navigation.current = { pathname: "/acme/issues" };
  });

  it("collapses and expands the Projects sub-nav", () => {
    const { container } = render(<AppSidebar />);
    const toggle = container.querySelector<HTMLElement>('button[aria-controls="sidebar-sub-nav-projects"]');

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByTestId("sidebar-menu-sub")).not.toBeNull();

    fireEvent.click(toggle!);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("sidebar-menu-sub")).toBeNull();

    fireEvent.click(toggle!);
    expect(screen.queryByTestId("sidebar-menu-sub")).not.toBeNull();
  });

  it("toggles the sub-nav when Projects is clicked on its own page", () => {
    navigation.current = { pathname: "/acme/projects" };
    const { container } = render(<AppSidebar />);
    const projects = container.querySelector<HTMLElement>('button[data-href="/acme/projects"]')!;

    fireEvent.click(projects);
    expect(screen.queryByTestId("sidebar-menu-sub")).toBeNull();

    fireEvent.click(projects);
    expect(screen.queryByTestId("sidebar-menu-sub")).not.toBeNull();
    navigation.current = { pathname: "/acme/issues" };
  });

  it("expands but never collapses when Projects is clicked from another page", () => {
    const { container } = render(<AppSidebar />);
    const projects = container.querySelector<HTMLElement>('button[data-href="/acme/projects"]')!;
    const toggle = container.querySelector<HTMLElement>('button[aria-controls="sidebar-sub-nav-projects"]')!;

    fireEvent.click(projects);
    expect(screen.queryByTestId("sidebar-menu-sub")).not.toBeNull();

    fireEvent.click(toggle);
    fireEvent.click(projects, { metaKey: true });
    expect(screen.queryByTestId("sidebar-menu-sub")).toBeNull();

    fireEvent.click(projects);
    expect(screen.queryByTestId("sidebar-menu-sub")).not.toBeNull();
  });

  it("keeps Help out of the sidebar", () => {
    render(<AppSidebar />);

    expect(screen.queryByTestId("help-launcher")).toBeNull();
  });
});

describe("personal nav — Chat", () => {
  beforeEach(() => {
    chatSessions.current = [];
    summary.current = [];
    navigation.current = { pathname: "/acme/issues" };
    chatStore.current = { activeSessionId: null, isOpen: false };
    appForeground.current = true;
  });

  // The mocked SidebarMenuButton exposes the AppLink target as `data-href`
  // and renders the label + badge as its children.
  const chatNav = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('button[data-href="/acme/chat"]');
  const chatBadge = (container: HTMLElement) =>
    chatNav(container)?.querySelector("number-flow-react") ?? null;

  it("keeps the persistent Chat counter static", () => {
    chatSessions.current = [{ id: "chat-1", unread_count: 2 }];
    const { container } = render(<AppSidebar />);
    const currentChatBadge = chatBadge(container) as (HTMLElement & { animated?: boolean }) | null;

    expect(currentChatBadge?.animated).toBe(false);
  });

  it("renders a Chat nav link to the workspace chat route", () => {
    const { container } = render(<AppSidebar />);
    expect(chatNav(container)).not.toBeNull();
  });

  it("badges the Chat nav with the summed unread_count of chat sessions", () => {
    chatSessions.current = [{ id: "a", unread_count: 3 }, { id: "b", unread_count: 2 }, { id: "c", unread_count: 0 }];
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "5");
  });

  it("shows no Chat unread badge when every session is read", () => {
    chatSessions.current = [{ id: "a", unread_count: 0 }, { id: "b" }];
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toBeNull();
  });

  it("excludes the session being viewed on the chat page from the badge", () => {
    // The thread list zeroes the open session's row badge; the aggregate
    // must follow, or a reply landing in the open conversation flashes a
    // count with no matching row.
    chatSessions.current = [{ id: "a", unread_count: 2 }, { id: "b", unread_count: 3 }];
    navigation.current = { pathname: "/acme/chat" };
    chatStore.current = { activeSessionId: "a", isOpen: false };
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "3");
  });

  it("excludes the viewed session when the floating chat window is open off-route", () => {
    chatSessions.current = [{ id: "a", unread_count: 2 }, { id: "b", unread_count: 3 }];
    navigation.current = { pathname: "/acme/issues" };
    chatStore.current = { activeSessionId: "a", isOpen: true };
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "3");
  });

  it("still counts a remembered selection when no chat surface is showing it", () => {
    // activeSessionId persists after the chat page closes; with both
    // surfaces closed nothing will auto mark-read, so the badge must count.
    chatSessions.current = [{ id: "a", unread_count: 2 }, { id: "b", unread_count: 3 }];
    navigation.current = { pathname: "/acme/issues" };
    chatStore.current = { activeSessionId: "a", isOpen: false };
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "5");
  });

  it("counts the active session while the floating window is open but the app is backgrounded", () => {
    // A reply landing while the app is not in the foreground is NOT auto
    // marked-read (MUL-4485), so its unread must still badge — otherwise the
    // notification is silently eaten while the user is away.
    chatSessions.current = [{ id: "a", unread_count: 2 }, { id: "b", unread_count: 3 }];
    navigation.current = { pathname: "/acme/issues" };
    chatStore.current = { activeSessionId: "a", isOpen: true };
    appForeground.current = false;
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "5");
  });

  it("counts the active session on the chat route while the app is backgrounded", () => {
    chatSessions.current = [{ id: "a", unread_count: 2 }, { id: "b", unread_count: 3 }];
    navigation.current = { pathname: "/acme/chat" };
    chatStore.current = { activeSessionId: "a", isOpen: false };
    appForeground.current = false;
    const { container } = render(<AppSidebar />);
    expect(chatBadge(container)).toHaveAttribute("aria-label", "5");
  });
});

describe("AI team nav — Knowledge base", () => {
  beforeEach(() => {
    knowledgeBases.current = [];
    navigation.current = { pathname: "/acme/issues" };
  });

  const pending = (open_mrs: number) => ({ annotations: 1, stale_pages: 1, open_mrs });
  const kbNav = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('button[data-href="/acme/kb"]');

  it("places Knowledge base right after Squads", () => {
    const { container } = renderWithI18n(<AppSidebar />);
    const hrefs = Array.from(container.querySelectorAll<HTMLElement>("button[data-href]")).map(
      (el) => el.dataset.href,
    );
    expect(hrefs.indexOf("/acme/kb")).toBe(hrefs.indexOf("/acme/squads") + 1);
    expect(kbNav(container)).toHaveTextContent("Knowledge base");
  });

  it("badges the nav with open merge requests summed across knowledge bases", () => {
    knowledgeBases.current = [
      { id: "a", pending: pending(2) },
      { id: "b", pending: pending(1) },
      { id: "c", pending: pending(0) },
    ];
    const { container } = render(<AppSidebar />);
    expect(kbNav(container)?.querySelector('[data-testid="kb-open-mr-badge"]')).toHaveTextContent("3");
  });

  it("hides the badge when nothing is waiting for review", () => {
    knowledgeBases.current = [{ id: "a", pending: pending(0) }];
    const { container } = render(<AppSidebar />);
    expect(kbNav(container)?.querySelector('[data-testid="kb-open-mr-badge"]')).toBeNull();
  });
});

describe("Pending invitation self-heal", () => {
  beforeEach(() => {
    invitationApi.accept.mockReset();
    invitationApi.decline.mockReset();
    invitationApi.invalidateQueries.mockClear();
    invitationApi.mutations.length = 0;
    invitationApi.accept.mockRejectedValue(new Error("invitation is not pending"));
    invitationApi.decline.mockRejectedValue(new Error("invitation is not pending"));
    navigation.current.pathname = "/acme/issues";
    workspaces.current = [];
  });

  // "invitation is not pending" means the row on screen was concluded from
  // another surface. Both mutations must invalidate the pending list on
  // failure so the stale row drops instead of surviving until restart.
  it("invalidates the pending-invitations list when accept or decline fails", async () => {
    render(<AppSidebar />);
    expect(invitationApi.mutations).toHaveLength(2);

    for (const options of invitationApi.mutations as Array<{
      mutationFn: (id: string) => Promise<unknown>;
      onError?: (...args: unknown[]) => unknown;
      onSettled?: (...args: unknown[]) => unknown;
    }>) {
      const settle = options.onError ?? options.onSettled;
      expect(settle).toBeTypeOf("function");
      invitationApi.invalidateQueries.mockClear();
      await expect(options.mutationFn("inv-1")).rejects.toThrow("invitation is not pending");
      await settle!(new Error("invitation is not pending"), "inv-1", undefined, undefined);
      expect(invitationApi.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["invitations"] });
    }
    expect(invitationApi.accept).toHaveBeenCalledTimes(1);
    expect(invitationApi.decline).toHaveBeenCalledTimes(1);
  });
});
