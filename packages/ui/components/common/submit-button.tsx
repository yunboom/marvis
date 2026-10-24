"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@marvis/ui/components/ui/tooltip";
import { cn } from "@marvis/ui/lib/utils";

interface SubmitButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  /**
   * Blocked on background work the user started (an attachment still
   * uploading) rather than on a missing precondition. Disables the button and
   * marks it `aria-busy`, so a screen reader reaching it with a virtual cursor
   * reads "busy" rather than an unexplained dead control. Pass the reason as
   * `disabledReason` so it stays hoverable and focusable.
   */
  busy?: boolean;
  /**
   * Why the button is disabled; shown as its tooltip instead of `tooltip`.
   * A natively disabled button takes no hover or focus, so with a reason the
   * button is `aria-disabled` and Base UI blocks activation instead. Ignored
   * while `loading`.
   */
  disabledReason?: ReactNode;
  running?: boolean;
  /** The stop request is in flight: the stop button spins and takes no clicks. */
  stopping?: boolean;
  onStop?: () => void;
  /**
   * Tooltip shown over the send button when idle. Pass a string or a node
   * (e.g. `Send · ⌘↵`). Omit to render no tooltip.
   * Callers compose the shortcut hint themselves to keep this component
   * free of `@marvis/core` (platform-detection) and i18n imports.
   */
  tooltip?: ReactNode;
  /** Accessible name for the icon-only submit button. */
  ariaLabel?: string;
  /** Tooltip shown over the stop button while a run is in progress. */
  stopTooltip?: ReactNode;
  /** Accessible name for the icon-only stop button. */
  stopAriaLabel?: string;
}

/** Keep the composer focused so Send and Stop do not dismiss Android's keyboard. */
function keepFocusInComposer(event: SyntheticEvent<HTMLButtonElement>) {
  event.preventDefault();
}

function SubmitButton({
  onClick,
  disabled,
  loading,
  busy,
  running,
  stopping,
  onStop,
  disabledReason,
  tooltip,
  ariaLabel,
  stopTooltip,
  stopAriaLabel,
}: SubmitButtonProps) {
  if (running || stopping) {
    const stopButton = (
      <Button
        size="icon-sm"
        className="relative rounded-full disabled:opacity-70"
        disabled={stopping}
        aria-busy={stopping || undefined}
        onPointerDown={keepFocusInComposer}
        onMouseDown={keepFocusInComposer}
        onClick={onStop}
        aria-label={stopAriaLabel}
      >
        {stopping ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <>
            {/* The turning arc says the run is still going while the square offers to end it. */}
            <svg
              data-slot="stop-running-ring"
              viewBox="0 0 36 36"
              className="absolute inset-0 size-full animate-spin [animation-duration:1.4s]"
              aria-hidden="true"
            >
              <circle
                cx="18"
                cy="18"
                r="16.5"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.55"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeDasharray="26 78"
              />
            </svg>
            <Square className="size-3 fill-current" aria-hidden="true" />
          </>
        )}
      </Button>
    );
    return stopTooltip ? (
      <Tooltip>
        <TooltipTrigger render={stopButton} />
        <TooltipContent side="top">{stopTooltip}</TooltipContent>
      </Tooltip>
    ) : stopButton;
  }

  const isDisabled = !!(disabled || loading || busy);
  const showReason = isDisabled && !loading && disabledReason != null && disabledReason !== false;
  const submitButton = (
    <Button
      size="icon-sm"
      className={cn(
        "rounded-full",
        // Waiting (sending, uploading) keeps the ink fill behind the spinner;
        // nothing to send drops to a quiet grey disc instead of dimmed ink.
        loading || busy
          ? "disabled:opacity-100 aria-disabled:opacity-100"
          : "disabled:bg-muted disabled:text-faint-foreground disabled:opacity-100 aria-disabled:bg-muted aria-disabled:text-faint-foreground aria-disabled:opacity-100",
        showReason && "aria-disabled:cursor-not-allowed aria-disabled:active:translate-y-0",
      )}
      disabled={isDisabled}
      focusableWhenDisabled={showReason}
      {...(busy && !showReason ? { "aria-disabled": true } : {})}
      aria-busy={loading || busy || undefined}
      onPointerDown={keepFocusInComposer}
      onMouseDown={keepFocusInComposer}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {loading || busy ? (
        // `busy` spins too, not just greys out: an upload can be running with
        // nothing else on screen to explain the disabled control (a reopened
        // composer is still rebuilding its placeholder, or the user deleted
        // it). A spinner says "waiting on something" without a hover; the
        // tooltip says what.
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <ArrowUp aria-hidden="true" />
      )}
    </Button>
  );
  const tooltipContent = showReason ? disabledReason : tooltip;
  const submitControl = !tooltipContent
    ? submitButton
    : (
        <Tooltip>
          <TooltipTrigger render={submitButton} />
          <TooltipContent side="top">{tooltipContent}</TooltipContent>
        </Tooltip>
      );
  return submitControl;
}

export { SubmitButton, type SubmitButtonProps };
