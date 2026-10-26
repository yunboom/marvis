import { useEffect } from "react";
import { createMemoryRouter, Outlet, useMatches } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { IssueDetailPage } from "./pages/issue-detail-page";
import { ProjectDetailPage } from "./pages/project-detail-page";
import { AutopilotDetailPage } from "./pages/autopilot-detail-page";
import { SkillDetailPage } from "./pages/skill-detail-page";
import { AgentDetailPage } from "./pages/agent-detail-page";
import { AiBuilderSessionPage } from "./pages/ai-builder-session-page";
import { MemberDetailPage } from "./pages/member-detail-page";
import {
  RuntimeDetailPage,
  RuntimeSettingsPage,
} from "./pages/runtime-detail-page";
import { AttachmentPreviewRoute } from "./pages/attachment-preview-page";
import { IssuesPage } from "@marvis/views/issues/components";
import { ProjectsPage } from "@marvis/views/projects/components";
import { DashboardPage } from "@marvis/views/dashboard";
import { AutopilotsPage } from "@marvis/views/autopilots/components";
import { WorkflowsPage } from "@marvis/views/workflows";
import { MyIssuesPage } from "@marvis/views/my-issues";
import { SkillsPage } from "@marvis/views/skills";
import { DesktopRuntimesPage } from "./components/desktop-runtimes-page";
import { DesktopAgentsPage } from "./components/desktop-agents-page";
import {
  AiCreateAgentPage,
  ManualCreateAgentPage,
} from "@marvis/views/agents";
import { DesktopChooseRuntimePage } from "./components/desktop-choose-runtime-page";
import { AgentCreatedPage } from "./pages/agent-created-page";
import { SquadsPage, SquadDetailPage as SquadDetailPageView } from "@marvis/views/squads/components";
import {
  KbBuilderPage,
  KbAnnotationsPage,
  KbHomePage,
  KbJobPage,
  KbJobsPage,
  KbListPage,
  KbPageView,
  KbRevisionDiffPage,
  KbShell,
} from "@marvis/views/kb";
import { InboxPage } from "@marvis/views/inbox";
import { ChatPage } from "@marvis/views/chat";
import { SettingsPage } from "@marvis/views/settings";
import { useT } from "@marvis/views/i18n";
import { Cpu, DownloadSimple, HardDrives } from "@phosphor-icons/react/ssr";
import { filled } from "@marvis/views/layout/route-icon-components";
import { DaemonSettingsTab } from "./components/daemon-settings-tab";
import { ServerSettingsTab } from "./components/server/server-settings-tab";
import { UpdatesSettingsTab } from "./components/updates-settings-tab";
import { WorkspaceRouteLayout } from "./components/workspace-route-layout";
import { DesktopRouteErrorPage } from "./components/route-error-page";

/**
 * Wraps `SettingsPage` so the desktop-only extra tabs can pull their labels
 * from i18n. The route element has to be a component (not a literal JSX
 * value) for `useT` to run.
 */
// Device tabs share the settings nav's solid glyph style.
const SERVER_ICON = filled(HardDrives);
const DAEMON_ICON = filled(Cpu);
const UPDATES_ICON = filled(DownloadSimple);

function DesktopSettingsRoute() {
  const { t } = useT("settings");
  return (
    <SettingsPage
      extraDeviceTabs={[
        {
          value: "server",
          label: t(($) => $.desktop.server.tab_label),
          icon: SERVER_ICON,
          content: <ServerSettingsTab />,
        },
        {
          value: "daemon",
          label: t(($) => $.desktop.daemon.title),
          icon: DAEMON_ICON,
          content: <DaemonSettingsTab />,
        },
        {
          value: "updates",
          label: t(($) => $.desktop.tabs.updates),
          icon: UPDATES_ICON,
          content: <UpdatesSettingsTab />,
        },
      ]}
    />
  );
}

/**
 * Sets document.title from the deepest matched route's handle.title.
 * The tab system observes document.title via MutationObserver.
 * Pages with dynamic titles (e.g. issue detail) override by setting
 * document.title directly via useDocumentTitle().
 */
function TitleSync() {
  const matches = useMatches();
  const title = [...matches]
    .reverse()
    .find((m) => (m.handle as { title?: string })?.title)
    ?.handle as { title?: string } | undefined;

  useEffect(() => {
    if (title?.title) document.title = title.title;
  }, [title?.title]);

  return null;
}

/** Wrapper that renders route children + TitleSync */
function PageShell() {
  return (
    <>
      <TitleSync />
      <Outlet />
    </>
  );
}

/** Knowledge base frame: the page tree stays mounted while pages change. */
function KbShellRoute() {
  return (
    <KbShell>
      <Outlet />
    </KbShell>
  );
}

/**
 * Route definitions shared by all tabs.
 *
 * Every tab path is workspace-scoped: `/{slug}/{route}/...`. Pre-workspace
 * flows (create workspace, accept invite) are NOT routes — they render as a
 * window-level overlay via `WindowOverlay`, dispatched by the navigation
 * adapter's transition-path interception. The `activeWorkspaceSlug` in the
 * tab store decides which workspace's tabs are visible in the TabBar;
 * workspace-less state (zero-workspace user) shows the overlay instead.
 *
 * The root index route stays as a harmless safety net. With per-workspace
 * tabs, nothing should construct a tab at `/` — but if one ever slips
 * through (malformed persisted state that dodges the migration, direct
 * router.navigate from unforeseen code), the index falls back to null
 * rather than 404; App.tsx's bootstrap repoints activeWorkspaceSlug on the
 * next render pass.
 */
export const appRoutes: RouteObject[] = [
  {
    element: <PageShell />,
    errorElement: <DesktopRouteErrorPage />,
    children: [
      { index: true, element: null },
      {
        path: ":workspaceSlug",
        element: <WorkspaceRouteLayout />,
        children: [
          // A bare `/{slug}` URL is normalized to `/{slug}/issues` by
          // sanitizeTabPath before it ever becomes a session, so the index
          // route is unreachable in practice; null keeps it a harmless
          // safety net instead of an in-router <Navigate> (MUL-4741
          // invariant 1: the router never self-navigates).
          { index: true, element: null },
          {
            path: "issues",
            element: <IssuesPage />,
            handle: { title: "Issues" },
          },
          {
            path: "issues/:id",
            element: <IssueDetailPage />,
            handle: { title: "Issue" },
          },
          {
            path: "projects",
            element: <ProjectsPage />,
            handle: { title: "Projects" },
          },
          {
            path: "projects/:id",
            element: <ProjectDetailPage />,
            handle: { title: "Project" },
          },
          {
            path: "workflows",
            element: <WorkflowsPage />,
            handle: { title: "Workflows" },
          },
          {
            path: "autopilots",
            element: <AutopilotsPage />,
            handle: { title: "Autopilot" },
          },
          {
            path: "autopilots/:id",
            element: <AutopilotDetailPage />,
            handle: { title: "Autopilot" },
          },
          {
            path: "my-issues",
            element: <MyIssuesPage />,
            handle: { title: "My Issues" },
          },
          {
            path: "runtimes",
            element: <DesktopRuntimesPage />,
            handle: { title: "Runtimes" },
          },
          {
            path: "runtimes/:id",
            element: <RuntimeDetailPage />,
            handle: { title: "Machine" },
          },
          {
            path: "runtimes/:id/runtime/:runtimeId",
            element: <RuntimeSettingsPage />,
            handle: { title: "Runtime" },
          },
          { path: "skills", element: <SkillsPage />, handle: { title: "Skills" } },
          {
            path: "skills/:id",
            element: <SkillDetailPage />,
            handle: { title: "Skill" },
          },
          { path: "agents", element: <DesktopAgentsPage />, handle: { title: "Agents" } },
          {
            path: "agents/new",
            element: <DesktopChooseRuntimePage />,
            handle: { title: "Create Agent" },
          },
          {
            path: "agents/new/done/:agentId",
            element: <AgentCreatedPage />,
            handle: { title: "Create Agent" },
          },
          {
            path: "agents/new/manual",
            element: <ManualCreateAgentPage />,
            handle: { title: "Create Agent" },
          },
          {
            path: "agents/new/ai",
            element: <AiCreateAgentPage />,
            handle: { title: "Create Agent" },
          },
          {
            path: "agents/new/ai/:sessionId",
            element: <AiBuilderSessionPage />,
            handle: { title: "Create Agent" },
          },
          {
            path: "agents/:id",
            element: <AgentDetailPage />,
            handle: { title: "Agent" },
          },
          {
            path: "members/:id",
            element: <MemberDetailPage />,
            handle: { title: "Member" },
          },
          { path: "squads", element: <SquadsPage />, handle: { title: "Squads" } },
          {
            path: "squads/:id",
            element: <SquadDetailPageView />,
            handle: { title: "Squad" },
          },
          { path: "kb", element: <KbListPage />, handle: { title: "Knowledge base" } },
          { path: "kb/new", element: <KbBuilderPage />, handle: { title: "New knowledge base" } },
          { path: "kb/new/:sessionId", element: <KbBuilderPage />, handle: { title: "New knowledge base" } },
          {
            path: "kb/:kbSlug",
            element: <KbShellRoute />,
            children: [
              { index: true, element: <KbHomePage />, handle: { title: "Knowledge base" } },
              { path: "config", element: <KbBuilderPage />, handle: { title: "Configure knowledge base" } },
              {
                path: "config/:sessionId",
                element: <KbBuilderPage />,
                handle: { title: "Configure knowledge base" },
              },
              { path: "annotations", element: <KbAnnotationsPage />, handle: { title: "Annotations" } },
              { path: "jobs", element: <KbJobsPage />, handle: { title: "Knowledge base jobs" } },
              { path: "jobs/new", element: <KbJobPage />, handle: { title: "New job" } },
              { path: "jobs/:jobId", element: <KbJobPage />, handle: { title: "Knowledge base job" } },
              { path: "p/:pageId", element: <KbPageView />, handle: { title: "Knowledge base" } },
              {
                path: "p/:pageId/history/:revisionId",
                element: <KbRevisionDiffPage />,
                handle: { title: "Page history" },
              },
            ],
          },
          { path: "inbox", element: <InboxPage />, handle: { title: "Inbox" } },
          { path: "chat", element: <ChatPage />, handle: { title: "Chat" } },
          {
            path: "attachments/:id/preview",
            element: <AttachmentPreviewRoute />,
            handle: { title: "Attachment" },
          },
          {
            path: "usage",
            element: <DashboardPage />,
            handle: { title: "Usage" },
          },
          {
            path: "settings",
            element: <DesktopSettingsRoute />,
            handle: { title: "Settings" },
          },
        ],
      },
    ],
  },
];

/**
 * Create THE app router (MUL-4741 single-router session architecture).
 * There is exactly one instance, owned by the tab Coordinator; it projects
 * the active tab session's URL and is never navigated by anything else.
 */
export function createAppRouter() {
  return createMemoryRouter(appRoutes, {
    initialEntries: ["/"],
  });
}
