"use client";

import type { ReactNode } from "react";
import { cn } from "@marvis/ui/lib/utils";
import { DeferredTooltip } from "./deferred-tooltip";

/** One hover-strip action of a list row (chat threads, knowledge base jobs). */
export function RowAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <DeferredTooltip
      content={label}
      trigger={
        <button
          type="button"
          aria-label={label}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
          }}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-row text-muted-foreground transition-colors duration-(--motion-fast) ease-out focus-visible:outline-none",
            danger
              ? "hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
              : "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground",
          )}
        >
          {icon}
        </button>
      }
    />
  );
}

/** An inline destructive confirm that takes over a row's second line. */
export function ConfirmRow({
  label,
  cancelText,
  confirmText,
  pending,
  onCancel,
  onConfirm,
}: {
  label: string;
  cancelText: string;
  confirmText: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-label font-medium text-destructive">{label}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onCancel();
          }}
          disabled={pending}
          className="inline-flex h-6 items-center rounded-full px-2 text-caption font-medium text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {cancelText}
        </button>
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onConfirm();
          }}
          disabled={pending}
          className="inline-flex h-6 items-center rounded-full bg-destructive/10 px-2 text-caption font-medium text-destructive transition-colors duration-(--motion-fast) ease-out hover:bg-destructive/15 disabled:opacity-50"
        >
          {confirmText}
        </button>
      </div>
    </div>
  );
}
