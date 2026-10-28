"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@marvis/ui/lib/utils";

/**
 * Dialog geometry for narrow screens: the popup docks to the bottom edge as a
 * sheet instead of floating in the middle. Applied on top of DialogContent's
 * centred defaults, so wider screens are unaffected.
 */
export const DIALOG_SHEET_ON_NARROW =
  "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none";

/** Dialog geometry for narrow screens where the content needs the whole screen. */
export const DIALOG_FULL_ON_NARROW =
  "max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * SegmentedRadio is a pill-shaped single choice (role, expiry). It behaves as
 * a radio group: one tab stop, arrow keys move the selection.
 */
export function SegmentedRadio<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  /** Accessible name of the group. */
  label: string;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
    if (step === 0) return;

    event.preventDefault();
    const nextIndex = (index + step + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;

    onChange(next.value);
    buttons.current[nextIndex]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex w-full items-center gap-1 rounded-full bg-field p-1", className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value;

        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "inline-flex h-8 min-w-0 flex-1 items-center justify-center truncate rounded-full px-3 text-label whitespace-nowrap transition-colors duration-(--motion-fast) ease-out focus-visible:outline-2 focus-visible:outline-ring",
              checked
                ? "bg-surface font-medium text-foreground shadow-control dark:bg-white/12"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** InviteEmptyState is the dashed placeholder of an empty list, with an optional call to action. */
export function InviteEmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lane border border-dashed border-surface-border px-4 py-10 text-center text-body text-muted-foreground">
      <div>{children}</div>
      {action}
    </div>
  );
}

/** RoleChip is the small pill that names a role in member and invite rows. */
export function RoleChip({
  role,
  children,
  className,
}: {
  role: "owner" | "admin" | "member";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-role={role}
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-caption whitespace-nowrap",
        role === "owner"
          ? "bg-foreground text-background"
          : role === "admin"
            ? "bg-identity-brown text-identity-brown-foreground"
            : "bg-field text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
