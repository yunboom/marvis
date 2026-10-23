"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  api,
  ApiError,
  DuplicateIssueErrorBodySchema,
  type DuplicateIssueErrorBody,
  parseWithFallback,
} from "@marvis/core/api";
import { useAuthStore } from "@marvis/core/auth";
import {
  completeOnboarding,
  useBootstrapMika,
  type OnboardingStep,
} from "@marvis/core/onboarding";
import type { AgentRuntime, Workspace } from "@marvis/core/types";
import { StepShell } from "./components/step-shell";
import { StepRuntimeConnect } from "./steps/step-runtime-connect";
import { StepPlatformFork } from "./steps/step-platform-fork";
import { OnboardingLogoutButton } from "./components/onboarding-logout-button";
import { NewWorkspacePage } from "../workspace/new-workspace-page";
import {
  getMikaOnboarding,
  INSTALL_RUNTIME_ISSUE_BODY,
  INSTALL_RUNTIME_ISSUE_TITLE,
  pickContentLang,
} from "./templates";
import { useT } from "../i18n";

/**
 * Creating a workspace: the standalone create page, then the runtime step that
 * provisions the workspace's Mika. Users are onboarded on signup, so this is
 * the only flow left — a user with no workspace lands here right after login,
 * and the workspace switcher's "new workspace" runs the same two steps.
 *
 * Two exit shapes feed onComplete:
 *   - Runtime-skipped (no runtime picked): create one install-runtime guide
 *     issue assigned to the member and open it. Once a runtime appears, the
 *     Runtimes page offers the same Mika bootstrap used by the connected path.
 *   - Runtime-connected: create or repair the workspace's Mika on the selected
 *     runtime, start one hidden onboarding kickoff, and open Mika's real chat.
 *
 * Both exits finish their writes BEFORE completeOnboarding: it refreshes the
 * user, and the web shell can redirect as soon as the user object changes.
 */
interface OnboardingFlowProps {
  onComplete: (
    workspace?: Workspace,
    destination?: OnboardingDestination,
  ) => void;
  /** Only passed when the user has a workspace to return to; without one the
   *  create page offers Log out instead. */
  onCancel?: () => void;
  runtimeInstructions?: React.ReactNode;
  /** Desktop wires this to restart the bundled daemon so a freshly
   *  installed agent CLI gets picked up on the runtime step. Web omits
   *  it — its CLI install flow already runs on the user's machine and
   *  the embedded picker reacts to daemon:register events. */
  onRuntimeRefresh?: () => void | Promise<void>;
  /** Desktop wires this to the local daemon's live status so the runtime
   *  step doesn't flash "no runtime found" while the daemon is still booting
   *  or probing CLI versions (MUL-5119). Web omits it. */
  runtimesPending?: boolean;
}

export function OnboardingFlow({
  onComplete,
  onCancel,
  runtimeInstructions,
  onRuntimeRefresh,
  runtimesPending,
}: OnboardingFlowProps) {
  const { t, i18n } = useT("onboarding");
  const user = useAuthStore((s) => s.user);
  if (!user) {
    throw new Error("OnboardingFlow requires an authenticated user");
  }

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const bootstrapMika = useBootstrapMika(workspace?.id ?? "");
  // Keyed by workspace so retrying Skip after completeOnboarding failed reuses
  // the guide issue instead of creating a second one.
  const guideIssueRef = useRef<{ workspaceId: string; issueId: string } | null>(
    null,
  );

  // Deliberately NOT setCurrentWorkspace: that singleton is also written by
  // the desktop tab system, which reclaims it whenever the new workspace has
  // no tab group yet. Racing it sent the rest of this flow — Mika, the
  // session, the kickoff — into the previously-active workspace. Every call
  // from here on names its target workspace instead, and the switch happens
  // once, on the navigation in onComplete.
  const handleWorkspaceCreated = useCallback((ws: Workspace) => {
    setWorkspace(ws);
  }, []);

  const handleRuntimeNext = useCallback(
    async (rt: AgentRuntime | null, model?: string) => {
      if (!workspace) return;

      // A connected runtime provisions only Mika and immediately opens the
      // real interactive onboarding conversation.
      if (rt) {
        const contentLang = pickContentLang(i18n.language);
        try {
          const result = await bootstrapMika.mutateAsync({
            workspaceSlug: workspace.slug,
            runtimeId: rt.id,
            model,
            ...getMikaOnboarding(contentLang),
          });
          await completeOnboarding("full", workspace.id);
          onComplete(workspace, {
            kind: "chat",
            sessionId: result.chatSession.id,
          });
        } catch (err) {
          toast.error(
            err instanceof Error
              ? err.message
              : t(($) => $.errors.mika_setup_failed),
          );
          throw err;
        }
        return;
      }

      let issueId =
        guideIssueRef.current?.workspaceId === workspace.id
          ? guideIssueRef.current.issueId
          : null;
      if (!issueId) {
        const contentLang = pickContentLang(i18n.language);
        try {
          const issue = await api.createIssue(
            {
              title: INSTALL_RUNTIME_ISSUE_TITLE[contentLang],
              description: INSTALL_RUNTIME_ISSUE_BODY[contentLang],
              status: "in_progress",
              priority: "high",
              assignee_type: "member",
              assignee_id: user.id,
            },
            workspace.slug,
          );
          issueId = issue.id;
        } catch (err) {
          // A reload, or a create whose response was lost, leaves the guide
          // from an earlier attempt in place; the duplicate guard then
          // answers with that issue, which is the one to open.
          const duplicate =
            err instanceof ApiError && err.status === 409
              ? parseWithFallback<DuplicateIssueErrorBody | null>(
                  err.body,
                  DuplicateIssueErrorBodySchema,
                  null,
                  { endpoint: "POST /api/issues (active_duplicate_issue)" },
                )
              : null;
          if (!duplicate) {
            toast.error(t(($) => $.errors.guide_failed));
            return;
          }
          issueId = duplicate.issue.id;
        }
        guideIssueRef.current = { workspaceId: workspace.id, issueId };
      }

      try {
        await completeOnboarding("runtime_skipped", workspace.id);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t(($) => $.errors.skip_failed),
        );
        return;
      }

      onComplete(workspace, { kind: "issue", issueId });
    },
    [bootstrapMika, i18n.language, workspace, onComplete, t, user.id],
  );

  if (!workspace) {
    return (
      <NewWorkspacePage onCreated={handleWorkspaceCreated} onCancel={onCancel} />
    );
  }

  // No back affordance and no rail navigation on the runtime step: once the
  // workspace exists there is nothing left to cancel, and walking back would
  // strand a workspace with no runtime, no Mika, and no guidance. Skip runs
  // the runtime-skipped path instead. Log out lives at the foot of the rail.
  return (
    <StepShell
      currentStep="runtime"
      chromeFooter={<OnboardingLogoutButton inline />}
    >
      {/* Desktop (no cliInstructions slot) drives the local daemon's runtime
          list directly; web offers Download / CLI / Cloud and embeds the live
          probe under the CLI path. */}
      {!runtimeInstructions ? (
        <StepRuntimeConnect
          wsId={workspace.id}
          wsSlug={workspace.slug}
          onNext={handleRuntimeNext}
          onRefresh={onRuntimeRefresh}
          runtimesPending={runtimesPending}
        />
      ) : (
        <StepPlatformFork
          wsId={workspace.id}
          wsSlug={workspace.slug}
          onNext={handleRuntimeNext}
          cliInstructions={runtimeInstructions}
        />
      )}
    </StepShell>
  );
}

export type OnboardingDestination =
  | { kind: "issue"; issueId: string }
  | {
      kind: "chat";
      sessionId: string;
    };

export type { OnboardingStep };
