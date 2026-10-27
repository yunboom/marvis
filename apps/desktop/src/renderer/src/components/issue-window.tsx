import { useMemo } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useParams,
  useRouteError,
} from "react-router-dom";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import { useAuthStore } from "@marvis/core/auth";
import { setCurrentWorkspace } from "@marvis/core/platform";
import { WorkspaceSlugProvider } from "@marvis/core/paths";
import { useWorkspaceList } from "@marvis/core/workspace";
import { Button } from "@marvis/ui/components/ui/button";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { ModalRegistry } from "@marvis/views/modals/registry";
import { WorkspacePresencePrefetch } from "@marvis/views/layout";
import { DragStrip } from "@marvis/views/platform";
import type { IssueWindowContext } from "../../../shared/issue-window";
import { DesktopAuthRecoveryPage } from "../pages/auth-recovery";
import { IssueDetailPage } from "../pages/issue-detail-page";
import { IssueWindowNavigationProvider } from "../platform/issue-window-navigation";

export function IssueWindow({ context }: { context: IssueWindowContext }) {
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          {
            path: ":workspaceSlug/issues/:id",
            element: <IssueWindowRoute />,
            errorElement: <IssueWindowRouteError />,
          },
        ],
        { initialEntries: [context.path] },
      ),
    [context.path],
  );

  return <RouterProvider router={router} />;
}

function IssueWindowRoute() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const user = useAuthStore((state) => state.user);
  const { workspaces, ready, unavailable, isFetching, refetch } =
    useWorkspaceList({
      enabled: !!user && !!workspaceSlug,
    });
  const workspace = workspaces.find((item) => item.slug === workspaceSlug);

  if (workspace && workspaceSlug) {
    setCurrentWorkspace(workspaceSlug, workspace.id);
  }

  if (unavailable) {
    return (
      <DesktopAuthRecoveryPage
        isRetrying={isFetching}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!ready) {
    return (
      <IssueWindowFrame>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <MarvisIcon className="size-12 animate-pulse" />
        </div>
      </IssueWindowFrame>
    );
  }

  if (!workspace || !workspaceSlug) {
    return <IssueWindowUnavailable />;
  }

  return (
    <WorkspaceSlugProvider slug={workspaceSlug}>
      <IssueWindowNavigationProvider>
        <WorkspacePresencePrefetch />
        <IssueWindowFrame>
          <IssueDetailPage onDelete={() => window.desktopAPI.closeWindow()} />
        </IssueWindowFrame>
        <ModalRegistry />
      </IssueWindowNavigationProvider>
    </WorkspaceSlugProvider>
  );
}

function IssueWindowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-dedicated-issue-window="true"
      className="flex h-screen min-h-0 flex-col bg-page-canvas text-foreground"
    >
      <DragStrip />
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function IssueWindowUnavailable() {
  return (
    <IssueWindowFrame>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-field text-muted-foreground">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 className="text-title font-semibold">Issue unavailable</h1>
          <p className="text-body text-muted-foreground">
            This workspace is no longer available in your account.
          </p>
        </div>
        <Button variant="outline" onClick={() => window.desktopAPI.closeWindow()}>
          Close window
        </Button>
      </div>
    </IssueWindowFrame>
  );
}

function IssueWindowRouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown route error";

  return (
    <IssueWindowFrame>
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 className="text-title font-semibold">Something went wrong</h1>
          <p className="max-w-lg truncate text-body text-muted-foreground">
            {message}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Reload
          </Button>
          <Button variant="outline" onClick={() => window.desktopAPI.closeWindow()}>
            <X className="size-4" aria-hidden="true" />
            Close window
          </Button>
        </div>
      </div>
    </IssueWindowFrame>
  );
}
