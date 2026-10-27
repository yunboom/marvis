"use client";

import type { ComponentProps, ReactNode } from "react";
import type { RouteIcon } from "./route-icon-components";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@marvis/ui/components/ui/empty";
import { cn } from "@marvis/ui/lib/utils";
import { PageHeader } from "./page-header";

/*
 * Collection page kit: the shared look of list pages (Projects, Agents,
 * Skills, Squads, Autopilots, Runtimes). The header, action, and empty state
 * are components below; the toolbar, table, and batch bar stay page-owned, so
 * their look is published as class constants that pages put on their own
 * elements. Every constant is styling only.
 */

/** Toolbar search: wrap the icon and `<Input>` in a `relative` element. */
export const COLLECTION_SEARCH_ICON =
  "pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground";

/** Filled search field, 32px, no border. Pair with `COLLECTION_SEARCH_ICON`. */
export const COLLECTION_SEARCH_INPUT =
  "h-8 w-60 rounded-lg border-0 bg-field pl-8 text-label hover:bg-field-hover focus-visible:bg-field-hover";

/**
 * Toolbar pill (filter, display, view, sort): put on a `<Button size="sm">`
 * with `variant="outline"` at rest, `variant="brand"` while a filter is on.
 * Icon-only below md is the page's own `w-8 px-0 md:w-auto` choice.
 */
export const COLLECTION_TOOLBAR_BUTTON =
  "h-8 gap-1.5 rounded-full px-3 text-label font-normal [&_svg:not([class*='size-'])]:size-3.5";

/** Muted text for a resting outline toolbar pill. */
export const COLLECTION_TOOLBAR_BUTTON_IDLE = "text-muted-foreground";

/** Horizontal inset of a collection table (or list) inside the main card. */
export const COLLECTION_TABLE_INSET = "px-4";

/**
 * Table header row: a 40px grey band with rounded ends and no rule under it.
 * For `<TableRow>` in `<TableHeader>`; the cells keep their own padding.
 */
export const COLLECTION_TABLE_HEAD_ROW =
  "border-0 hover:bg-transparent [&>th]:h-10 [&>th]:bg-surface-sunken [&>th]:text-label [&>th]:font-normal [&>th]:text-muted-foreground [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg";

/** Same band for grid/div based lists. */
export const COLLECTION_LIST_HEAD =
  "flex h-10 items-center rounded-lg bg-surface-sunken text-label text-muted-foreground";

/**
 * Body row, 48px: hairline divider, #f5f5f5 hover that comes in over 100ms
 * and leaves over 150ms. Works on `<TableRow>` and on div rows.
 */
export const COLLECTION_ROW =
  "h-12 border-b border-border text-body transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:duration-(--motion-instant)";

/** Two-line row (avatar + name over a description), 64px. Use with `COLLECTION_ROW`. */
export const COLLECTION_ROW_TALL = "h-16";

/** A selected (checked) row. */
export const COLLECTION_ROW_SELECTED = "bg-surface-selected hover:bg-surface-selected";

/** Card in a collection grid view. */
export const COLLECTION_CARD =
  "rounded-xl border border-border bg-card transition-colors duration-(--motion-fast) ease-out hover:border-input hover:duration-(--motion-instant)";

/**
 * Selection batch bar: a floating pill centred near the bottom of the page.
 * The page root must be `relative`. Leading count, then
 * `COLLECTION_BATCH_DIVIDER`, then `<Button variant="ghost" size="sm"
 * className={COLLECTION_BATCH_ACTION}>` actions.
 */
export const COLLECTION_BATCH_BAR =
  "absolute bottom-6 left-1/2 z-50 flex h-11 -translate-x-1/2 animate-content-rise items-center gap-1 rounded-full border border-border bg-popover pr-1.5 pl-4 text-popover-foreground shadow-menu max-md:above-chat-launcher";

/** Vertical rule between the batch bar's count and its actions. */
export const COLLECTION_BATCH_DIVIDER = "mx-1.5 h-5 w-px shrink-0 bg-border";

/** Batch bar action button (on a ghost `Button size="sm"`). */
export const COLLECTION_BATCH_ACTION = "h-8 rounded-full px-3 text-label font-normal";

interface CollectionPageHeaderProps {
  icon: RouteIcon;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  learnMore?: {
    href: string;
    label: ReactNode;
  };
  actions?: ReactNode;
  className?: string;
}

/**
 * Shared dashboard collection header: entity icon, title, optional count and
 * supporting copy on the left; page-level actions on the right.
 */
export function CollectionPageHeader({
  icon: Icon,
  title,
  count,
  description,
  learnMore,
  actions,
  className,
}: CollectionPageHeaderProps) {
  return (
    <PageHeader className={cn("h-18 gap-2.5 border-b-0", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Icon
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground"
        />
        <h1 className="truncate text-display-sm font-bold">{title}</h1>
        {typeof count === "number" && count > 0 ? (
          <span className="shrink-0 font-mono text-body-lg tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
        {description || learnMore ? (
          <p className="ml-2 hidden min-w-0 truncate text-label text-muted-foreground md:block">
            {description}
            {learnMore ? (
              <>
                {description ? " " : null}
                <a
                  href={learnMore.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground"
                >
                  {learnMore.label}
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </PageHeader>
  );
}

interface CollectionPageHeaderActionProps
  extends Omit<ComponentProps<typeof Button>, "children"> {
  icon: RouteIcon;
  label: string;
}

/** Responsive collection action: icon-only below md, labelled above md. */
export function CollectionPageHeaderAction({
  icon: Icon,
  label,
  className,
  type = "button",
  size = "sm",
  variant = "outline",
  ...props
}: CollectionPageHeaderActionProps) {
  const accessibleLabel = props["aria-label"] ?? label;

  return (
    <Button
      type={type}
      size={size}
      variant={variant}
      className={cn(
        "h-9 w-9 gap-1.5 px-0 text-body md:w-auto md:pr-4 md:pl-3.5",
        className,
      )}
      aria-label={accessibleLabel}
      {...props}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

type PageStateTone = "muted" | "destructive" | "warning";

interface CollectionPageStateProps {
  icon: RouteIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: PageStateTone;
  role?: "alert" | "status";
  className?: string;
}

const stateToneClass: Record<PageStateTone, string> = {
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  warning: "text-warning",
};

/** Shared centered state for collection empty, error and not-found views. */
export function CollectionPageState({
  icon: Icon,
  title,
  description,
  actions,
  tone = "muted",
  role,
  className,
}: CollectionPageStateProps) {
  return (
    <Empty
      role={role}
      className={cn("gap-3 rounded-none border-0 px-6 pt-16 pb-24", className)}
    >
      <EmptyHeader className="gap-2">
        <EmptyMedia
          variant="icon"
          className={cn(
            "mb-1 size-12 rounded-full bg-surface-sunken [&_svg]:size-6",
            stateToneClass[tone],
          )}
        >
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-body-lg font-semibold">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="max-w-md">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {actions ? (
        <EmptyContent className="mt-1 flex-row justify-center">
          {actions}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
