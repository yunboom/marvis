"use client";

import { statusCategoryOfKey } from "@marvis/core/issues";
import { useState } from "react";
import { ArrowRight, Download, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@marvis/ui/components/ui/button";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { cn } from "@marvis/ui/lib/utils";
import { DragStrip } from "@marvis/views/platform";
import { STATUS_CONFIG } from "@marvis/core/issues/config";
import type { BuiltInIssueStatus } from "@marvis/core/types";
import { StatusIcon } from "../../issues/components/status-icon";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { useT } from "../../i18n";

/**
 * Step 0 — the one-shot product intro shown on every onboarding
 * entry (which-step-are-you-on is not persisted). Returning users
 * who are already onboarded never reach this screen; they're gated
 * out earlier by `!hasOnboarded`.
 *
 * Layout: two-column editorial hero on lg+, single column below.
 * Left = wordmark + serif headline + lede + CTA; right = a stack of
 * mock issue cards that show what human/agent collaboration looks
 * like on the board — the thing the user is about to create. The
 * right column is an illustration, not content: hidden below lg so
 * the headline and CTA stay the focus on narrow viewports.
 *
 * `onSkip`, when provided, renders a secondary ghost CTA that marks
 * onboarding complete server-side and sends the user straight to
 * their existing workspace. OnboardingFlow only passes it when the
 * user has ≥ 1 workspace — without that, skipping lands in limbo.
 *
 * `isWeb` flips two things when true: the subheading acknowledges
 * that web users have an extra runtime step (so "3 minutes" stops
 * being a lie), and a "Download Desktop" secondary CTA surfaces
 * before the user has invested in questionnaire / workspace. Desktop
 * bundles a daemon, so the same prompt would be noise there.
 */
// 欢迎页大按钮：48 高、24 内边距、15 号字。
const WELCOME_CTA_CLASS = "h-12 gap-2 px-6 text-body-lg";

export function StepWelcome({
  onNext,
  onSkip,
  isWeb = false,
}: {
  onNext: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  isWeb?: boolean;
}) {
  const { t } = useT("onboarding");
  // Tracks which button is mid-flight so we can show a per-button
  // spinner and disable both while one is in progress.
  const [pending, setPending] = useState<"next" | "skip" | null>(null);

  const handleNext = async () => {
    if (pending) return;
    setPending("next");
    try {
      await onNext();
    } finally {
      setPending(null);
    }
  };

  const handleSkip = async () => {
    if (pending || !onSkip) return;
    setPending("skip");
    try {
      await onSkip();
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="animate-onboarding-enter flex h-full min-h-[640px] flex-col bg-app-shell lg:grid lg:grid-cols-2 lg:gap-4 lg:p-4">
      {/* Left — prose + CTA */}
      <div className="flex min-w-0 flex-col">
        <DragStrip />
        <div className="flex flex-1 flex-col justify-center px-6 pb-12 sm:px-10 md:px-18 lg:px-18 lg:pb-0">
          <div className="flex w-full max-w-[540px] flex-col gap-8">
            <div className="flex items-center gap-2.5">
              <MarvisIcon className="size-[22px] text-foreground" noSpin />
              <span className="text-[17px] font-semibold">
                {t(($) => $.welcome.wordmark)}
              </span>
            </div>

            <h1 className="text-balance text-5xl leading-[1.12] font-bold tracking-[-0.01em] sm:text-[52px]">
              {t(($) => $.welcome.headline_line1)}
              <br />
              {t(($) => $.welcome.headline_line2)}{" "}
              <em className="italic text-brand">{t(($) => $.welcome.headline_emphasis)}</em>
            </h1>

            <div className="flex flex-col gap-3.5">
              <p className="text-title leading-[1.7] text-foreground">
                {t(($) => $.welcome.lede)}
              </p>
              {isWeb && (
                <p className="text-body leading-[1.7] text-muted-foreground">
                  {t(($) => $.welcome.lede_web)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {isWeb ? (
                <>
                  {/* `<a>` rather than `<Button onClick={window.open}>`
                      so middle-click / cmd-click / "Copy link" all
                      behave and screen readers announce it as a link
                      (it navigates; `Continue on web` is the button
                      that mutates flow state). New tab preserves this
                      onboarding tab in case the desktop install
                      stalls and the user falls back here. */}
                  <a
                    href="/download"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ size: "lg" }), WELCOME_CTA_CLASS)}
                  >
                    <Download className="h-4 w-4" />
                    {t(($) => $.welcome.download_desktop)}
                  </a>
                  <Button
                    size="lg"
                    variant="outline"
                    className={cn(WELCOME_CTA_CLASS, "bg-background")}
                    onClick={handleNext}
                    disabled={pending !== null}
                  >
                    {pending === "next" && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    {t(($) => $.welcome.continue_on_web)}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <Button
                  size="lg"
                  className={WELCOME_CTA_CLASS}
                  onClick={handleNext}
                  disabled={pending !== null}
                >
                  {pending === "next" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {t(($) => $.welcome.start_exploring)}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
              {onSkip && (
                <Button
                  size="lg"
                  variant="ghost"
                  className={cn(WELCOME_CTA_CLASS, "px-5 text-muted-foreground")}
                  onClick={handleSkip}
                  disabled={pending !== null}
                >
                  {pending === "skip" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {t(($) => $.welcome.skip_existing)}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right — mock issue cards illustration. Hidden on < lg.
          Flex row on lg+ with `items-stretch` (default) makes both
          columns take the container's full height, so the muted bg
          fills the viewport edge-to-edge. `justify-center` inside
          centers the mock cards vertically, mirroring the left
          column's copy-center layout. */}
      <div className="hidden min-w-0 rounded-2xl bg-background ring-1 ring-surface-border lg:flex lg:flex-col lg:overflow-hidden">
        <DragStrip />
        <div className="flex flex-1 flex-col items-center justify-center gap-7 p-12">
          <WelcomeIllustration />
        </div>
      </div>
    </div>
  );
}


/**
 * A day in a solo user's multi-agent workspace. Five activity cards
 * woven through 3 shared issues (MCA-42 appears 3×) so the reader can
 * *see* agents referencing each other's work — the product's
 * "one workspace, shared context" thesis rendered concretely.
 *
 * Cards use slight rotations + indents to feel like a hand-stacked
 * pile rather than a neat feed, which matches the editorial-hero
 * aesthetic of the left column.
 */
function WelcomeIllustration() {
  const { t } = useT("onboarding");
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-3">
      <MockActivityCard
        actor={{
          kind: "user",
          name: t(($) => $.welcome.illustration.card1_actor_name),
          initial: t(($) => $.welcome.illustration.card1_actor_initial),
        }}
        issueId="MCA-42"
        content={
          <>
            <Mention>{t(($) => $.welcome.illustration.card1_mention_content)}</Mention>
            {t(($) => $.welcome.illustration.card1_body_prefix)}
            <Mention>{t(($) => $.welcome.illustration.card1_mention_research)}</Mention>
            {t(($) => $.welcome.illustration.card1_body_suffix)}
          </>
        }
      />
      <MockActivityCard
        className="-translate-x-5 -rotate-[1.2deg]"
        actor={{
          kind: "agent",
          name: t(($) => $.welcome.illustration.card2_actor_name),
          provider: "codex",
        }}
        issueId="MCA-42"
        content={t(($) => $.welcome.illustration.card2_body)}
        status="in_progress"
      />
      <MockActivityCard
        className="translate-x-8 rotate-[1.6deg]"
        actor={{
          kind: "agent",
          name: t(($) => $.welcome.illustration.card3_actor_name),
          provider: "hermes",
        }}
        issueId="MCA-38"
        content={t(($) => $.welcome.illustration.card3_body)}
        status="done"
        timestamp={t(($) => $.welcome.illustration.card3_timestamp)}
      />
      <MockActivityCard
        className="-translate-x-6 -rotate-[0.8deg]"
        actor={{
          kind: "agent",
          name: t(($) => $.welcome.illustration.card4_actor_name),
          provider: "openclaw",
        }}
        issueId="MCA-42"
        content={t(($) => $.welcome.illustration.card4_body)}
        status="in_review"
      />
      <MockActivityCard
        className="translate-x-6 rotate-[1deg]"
        actor={{
          kind: "agent",
          name: t(($) => $.welcome.illustration.card5_actor_name),
          provider: "claude",
        }}
        issueId="MCA-35"
        content={
          <>
            {t(($) => $.welcome.illustration.card5_body_prefix)}
            <Mention>{t(($) => $.welcome.illustration.card5_mention_you)}</Mention>
            {t(($) => $.welcome.illustration.card5_body_suffix)}
          </>
        }
        status="done"
        timestamp={t(($) => $.welcome.illustration.card5_timestamp)}
      />
    </div>
  );
}

type ProviderName =
  | "claude"
  | "codex"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "kimi"
  | "kiro"
  | "qoder"
  | "pi"
  | "copilot"
  | "cursor";

type ActivityActor =
  | { kind: "user"; name: string; initial: string }
  | { kind: "agent"; name: string; provider: ProviderName };

function MockActivityCard({
  actor,
  issueId,
  content,
  status,
  timestamp,
  className,
}: {
  actor: ActivityActor;
  issueId: string;
  content: React.ReactNode;
  status?: Extract<BuiltInIssueStatus, "in_progress" | "done" | "in_review">;
  timestamp?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-surface-border bg-background px-4 py-3.5 shadow-control",
        // Decorative hover: lift, straighten, deeper shadow. Cards aren't
        // clickable — this is ambient polish so the illustration feels like
        // real app UI rather than a flat screenshot.
        "transition-all duration-200 ease-out will-change-transform",
        "hover:-translate-y-0.5 hover:rotate-0 hover:shadow-surface",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MockAvatar actor={actor} />
          <span className="truncate text-body font-medium text-foreground">
            {actor.name}
          </span>
        </div>
        <span className="shrink-0 font-mono text-micro text-muted-foreground">
          {issueId}
        </span>
      </div>

      <p className="mt-2.5 text-body leading-[1.55] text-foreground">
        {content}
      </p>

      {status && <StatusFooter status={status} timestamp={timestamp} />}
    </div>
  );
}

function MockAvatar({ actor }: { actor: ActivityActor }) {
  if (actor.kind === "user") {
    return (
      <div
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-identity-gray text-[10px] font-semibold text-identity-gray-foreground"
      >
        {actor.initial}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-identity-gray text-identity-gray-foreground"
    >
      <ProviderLogo provider={actor.provider} className="size-3" />
    </div>
  );
}

function StatusFooter({
  status,
  timestamp,
}: {
  status: BuiltInIssueStatus;
  timestamp?: string;
}) {
  // The illustration's statuses are hard-coded BUILT-IN keys, so the label
  // resolves from i18n exactly the way `useStatusLabel` does for real issues
  // (MUL-6243) — `STATUS_CONFIG` still owns the icon color, but its `.label`
  // is the server's English seed and must never reach the screen.
  const { t } = useT("issues");
  const category = statusCategoryOfKey(status);
  const cfg = STATUS_CONFIG[category];
  return (
    <div className="mt-3 flex items-center gap-2 text-caption">
      <span
        className={cn("flex items-center gap-1.5 font-medium", cfg.iconColor)}
      >
        <StatusIcon
          status={status}
          className={cn(
            "h-3.5 w-3.5",
            status === "in_progress" && "animate-pulse",
          )}
        />
        {t(($) => $.status[status])}
      </span>
      {timestamp && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{timestamp}</span>
        </>
      )}
    </div>
  );
}

function Mention({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-brand">{children}</span>;
}
