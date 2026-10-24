"use client";

import { X as XIcon } from "lucide-react";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { cn } from "@marvis/ui/lib/utils";

// Shared pill chrome. `PillButton` puts it on the button itself; the clearable
// variant puts it on the shell that holds the trigger and the clear button, so
// both read as the same object.
//
// Hard width cap: pills carry user-generated text (project title, assignee
// name, label names), and the create toolbars are flex-wrap rows — an uncapped
// pill stretches until it owns the whole line and pushes every sibling to the
// next one. 14rem matches the chat composer's project pill. `min-w-0` +
// `overflow-hidden` let the inner `truncate` spans actually shrink (a flex item
// only drops `min-width: auto` once its overflow is hidden); leading icons are
// `shrink-0`, so the text yields first.
//
// A pill is an xs control: it takes its height from the shared control ladder
// (`--button-height-xs`, same caption type as `Button size="xs"`), not from
// vertical padding — padding lets the tallest child set the height, so a row
// of pills drifts apart. The pill also sizes what it holds to the 16px caption
// line, so call sites never pick a tier that outgrows it: avatars through
// `--avatar-slot-size` (read by the base avatar), label chips by dropping
// their vertical padding.
const PILL_SHELL =
  "inline-flex items-center rounded-full min-w-0 max-w-56 overflow-hidden transition-colors " +
  "[--avatar-slot-size:1rem] [&_[data-slot=label-chip]]:py-0";
const PILL_CHROME = cn(PILL_SHELL, "h-[var(--button-height-xs)] border text-caption");

// Ghost pills sit in a borderless property row (the create-issue modal): no
// fill or border at rest, a 30px hit target and label-size text. They tint
// only on hover and while their popover is open. The priority dot fills only
// part of its box, so here it is drawn at 20px to match the status ring beside
// it, with negative margins keeping its 14px footprint.
const GHOST_PILL_CHROME = cn(
  PILL_SHELL,
  "h-[30px] text-label text-foreground",
  "[&_[data-slot=priority-icon]]:size-5 [&_[data-slot=priority-icon]]:-mx-[3px]",
);

// An unset ghost pill shows its icon alone. The value text stays in the DOM
// as `sr-only`, so the pill keeps its accessible name; the picker's tooltip
// names the property on hover.
const ICON_ONLY = "justify-center [&>span]:sr-only [&>svg]:text-muted-foreground";

/** Visual style of a pill. `ghost` is borderless and unfilled at rest. */
export type PillVariant = "default" | "ghost";

interface PillStyleProps {
  /** Defaults to `default`, the bordered pill used across create toolbars. */
  variant?: PillVariant;
  /** Ghost only: render the leading icon alone, for an unset field. */
  iconOnly?: boolean;
}

export function PillButton({
  children,
  className,
  variant = "default",
  iconOnly = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & PillStyleProps) {
  const ghost = variant === "ghost";
  return (
    <button
      type="button"
      data-variant={variant}
      className={cn(
        ghost ? GHOST_PILL_CHROME : PILL_CHROME,
        ghost && iconOnly ? cn("w-[30px] shrink-0 px-0", ICON_ONLY) : "gap-1.5 px-2.5",
        ghost ? "hover:bg-accent" : "hover:bg-accent/60",
        "cursor-pointer",
        "data-popup-open:bg-accent data-popup-open:text-accent-foreground",
        "disabled:cursor-not-allowed disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Pill trigger with a trailing quick-clear ×, for pills whose value can be
 * dropped in one click (project context, parent link, …). Same chrome as
 * `PillButton`, so a row can mix the two.
 *
 * Two sibling `<button>`s inside a plain shell — never a button nested in a
 * button, and never the overlay × this replaces: that one was an absolutely
 * positioned sibling of the trigger, so every caller had to reserve right
 * padding for it and three of five didn't, painting the × over the value
 * (MUL-5666).
 *
 * The root stays a `<span>` whether or not `onClear` is set. Presence of the
 * clear action tracks "the field has a value", which flips in the same commit
 * that closes the popover — swapping the root element type there would remount
 * the popover's own trigger mid-close.
 *
 * Forwarded props (including the `ref`, `onClick` and `data-popup-open` that
 * Base UI's `render` merges in) land on the inner trigger button, so the
 * popover anchors to the trigger and the × stays outside its hit area.
 */
export function ClearablePillButton({
  children,
  className,
  onClear,
  clearLabel,
  disabled,
  variant = "default",
  iconOnly = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & PillStyleProps & {
  /** Omit to render a plain pill — the × appears only when there is a value
   *  to drop. */
  onClear?: (() => void) | undefined;
  /** Accessible name for the × ("Clear project"). Required whenever
   *  `onClear` is set: the button has no text. */
  clearLabel?: string;
}) {
  // A disabled trigger disables clearing too: both are writes to the same
  // field, and a read-only pill that can still be emptied is not read-only.
  const clearable = !!onClear && !disabled;
  const ghost = variant === "ghost";
  return (
    <span
      data-variant={variant}
      className={cn(
        ghost ? GHOST_PILL_CHROME : PILL_CHROME,
        !disabled && (ghost ? "hover:bg-accent" : "hover:bg-accent/60"),
        // The open-state highlight lives on the trigger (Base UI stamps the
        // attribute there), but it has to paint the whole pill.
        "has-[[data-popup-open]]:bg-accent has-[[data-popup-open]]:text-accent-foreground",
        className,
      )}
    >
      <button
        type="button"
        disabled={disabled}
        className={cn(
          "flex h-full min-w-0 items-center overflow-hidden cursor-pointer",
          ghost && iconOnly
            ? cn("w-[30px] shrink-0", ICON_ONLY)
            : cn("gap-1.5 pl-2.5", clearable ? "pr-1" : "pr-2.5"),
          "disabled:cursor-not-allowed",
        )}
        {...props}
      >
        {children}
      </button>
      {clearable && (
        <TooltipHint label={clearLabel}>
          <button
            type="button"
            aria-label={clearLabel}
            onClick={(e) => {
              e.stopPropagation();
              onClear?.();
            }}
            className="flex h-full shrink-0 items-center pl-0.5 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <XIcon className="size-3" />
          </button>
        </TooltipHint>
      )}
    </span>
  );
}
