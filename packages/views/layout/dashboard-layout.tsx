"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@marvis/ui/components/ui/sidebar";
import { useCurrentWorkspace } from "@marvis/core/paths";
import { ModalRegistry } from "../modals/registry";
import { AppSidebar } from "./app-sidebar";
import { DashboardGuard } from "./dashboard-guard";
import { LarkInviteWelcome } from "./lark-invite-welcome";
import { NavigationProgress } from "./navigation-progress";
import { WorkspacePresencePrefetch } from "./workspace-presence-prefetch";
import { GlobalShortcuts } from "./global-shortcuts";

interface DashboardLayoutProps {
  children: ReactNode;
  /** Rendered inside SidebarInset (e.g. ChatWindow, ChatFab — absolute-positioned overlays) */
  extra?: ReactNode;
  /** Rendered inside sidebar header as a search trigger */
  searchSlot?: ReactNode;
  /** Loading indicator */
  loadingIndicator?: ReactNode;
}

// Only mounted inside DashboardGuard, where the current workspace is resolved;
// hands its id and name to the one-time Feishu invite welcome toast.
function CurrentWorkspaceLarkInviteWelcome() {
  const workspace = useCurrentWorkspace();
  if (!workspace) return null;

  return <LarkInviteWelcome wsId={workspace.id} workspaceName={workspace.name} />;
}

export function DashboardLayout({
  children,
  extra,
  searchSlot,
  loadingIndicator,
}: DashboardLayoutProps) {
  return (
    <DashboardGuard
      loadingFallback={
        <div className="flex h-svh items-center justify-center">
          {loadingIndicator}
        </div>
      }
    >
      <SidebarProvider className="h-svh bg-app-shell">
        <GlobalShortcuts />
        <WorkspacePresencePrefetch />
        <CurrentWorkspaceLarkInviteWelcome />
        <AppSidebar searchSlot={searchSlot} />
        <SidebarInset className="relative overflow-hidden">
          <NavigationProgress />
          {children}
          <ModalRegistry />
          {extra}
        </SidebarInset>
      </SidebarProvider>
    </DashboardGuard>
  );
}
