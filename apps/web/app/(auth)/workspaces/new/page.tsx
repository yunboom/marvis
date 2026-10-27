"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@marvis/core/auth";
import { paths } from "@marvis/core/paths";
import { workspaceListOptions } from "@marvis/core/workspace/queries";
import { CliInstallInstructions, OnboardingFlow } from "@marvis/views/onboarding";

/**
 * Creating a workspace: the create page, then connecting a runtime so the new
 * workspace gets its own Mika. A user with no workspace lands here right after
 * login.
 */
export default function Page() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const { data: wsList = [] } = useQuery({
    ...workspaceListOptions(),
    enabled: !!user,
  });

  useEffect(() => {
    if (!isLoading && !user) router.replace(paths.login());
  }, [isLoading, user, router]);

  if (isLoading || !user) return null;

  // Cancel goes to the root path — the workspace layout redirects from there
  // to the user's default workspace. Only offered when there is somewhere to
  // return to.
  const onCancel =
    wsList.length > 0 ? () => router.push(paths.root()) : undefined;

  return (
    <div className="h-full overflow-y-auto bg-app-shell">
      <OnboardingFlow
        onCancel={onCancel}
        onComplete={(ws, destination) => {
          if (ws && destination?.kind === "chat") {
            router.push(
              paths.workspace(ws.slug).chatSession(destination.sessionId),
            );
          } else if (ws && destination?.kind === "issue") {
            router.push(
              paths.workspace(ws.slug).issueDetail(destination.issueId),
            );
          } else if (ws) {
            router.push(paths.workspace(ws.slug).issues());
          } else {
            router.push(paths.root());
          }
        }}
        runtimeInstructions={<CliInstallInstructions />}
      />
    </div>
  );
}
