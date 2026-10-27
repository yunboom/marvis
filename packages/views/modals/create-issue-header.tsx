"use client";

import type { KeyboardEvent } from "react";
import { Maximize2, Minimize2, MoreHorizontal, Sparkle, X as XIcon } from "lucide-react";
import type { CreateMode } from "@marvis/core/issues/stores/create-mode-store";
import { useShortcut } from "@marvis/core/shortcuts";
import { BorderBeam } from "@marvis/ui/components/common/border-beam";
import { cn } from "@marvis/ui/lib/utils";
import { DeferredTooltip } from "../common/deferred-tooltip";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { useT } from "../i18n";

const ICON_BUTTON_CLASS =
  "flex size-7.5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:text-foreground cursor-pointer";

// Segmented control, the same shape as the collection-page scope switches: a
// grey track with a raised white thumb on the selected mode, so the two modes
// read as a switch rather than two labels.
const TABLIST_CLASS =
  "flex min-w-0 items-center gap-0.5 rounded-full bg-field p-0.75";

const TAB_CLASS =
  "relative flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-label transition-[color,background-color,box-shadow] duration-(--motion-fast) ease-out outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

const TAB_SELECTED_CLASS =
  "bg-surface font-medium text-foreground shadow-control dark:bg-white/12";

/**
 * Header shared by both create-issue panels: the agent / manual mode tabs on
 * the left, expand and close on the right.
 *
 * Each panel owns its own switch logic (draft hand-off, upload gate), so the
 * header only reports which way to go through `onSwitch`. Only the
 * unselected tab is interactive; arrow keys on the selected tab switch too,
 * following the tablist pattern. Tooltips use DeferredTooltip so the dialog's
 * initial focus never pops one open.
 */
export function CreateIssueHeader({
  mode,
  onSwitch,
  switchDisabled,
  isExpanded,
  setIsExpanded,
  onClose,
}: {
  mode: CreateMode;
  onSwitch: () => void;
  /** Blocks the switch while an upload is in flight. */
  switchDisabled: boolean;
  isExpanded: boolean;
  setIsExpanded: (v: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useT("modals");
  const expandLabel = isExpanded
    ? t(($) => $.common.collapse_tooltip)
    : t(($) => $.common.expand_tooltip);

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (!switchDisabled) onSwitch();
  };

  const tab = (tabMode: CreateMode) => {
    const selected = mode === tabMode;
    const isAgent = tabMode === "agent";
    const button = (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        disabled={!selected && switchDisabled}
        aria-busy={(!selected && switchDisabled) || undefined}
        onClick={selected ? undefined : onSwitch}
        onKeyDown={selected ? onTabKeyDown : undefined}
        className={cn(
          TAB_CLASS,
          selected
            ? TAB_SELECTED_CLASS
            : "text-muted-foreground hover:text-foreground cursor-pointer",
        )}
      >
        {isAgent && <Sparkle className="size-3.5" aria-hidden="true" />}
        {isAgent ? t(($) => $.create_issue.tab_agent) : t(($) => $.create_issue.tab_manual)}
        {/* In manual mode the ink stroke circles the agent tab as an
            invitation; in agent mode the agent panel draws it around the
            whole dialog instead. */}
        {isAgent && !selected && <BorderBeam variant="ink" />}
      </button>
    );
    if (selected) return button;
    return (
      <DeferredTooltip
        side="bottom"
        content={
          isAgent
            ? t(($) => $.create_issue.switch_to_agent_tooltip)
            : t(($) => $.create_issue.switch_to_manual_tooltip)
        }
        trigger={button}
      />
    );
  };

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 pt-5 pr-4 pb-1 pl-[1.125rem]">
      <div
        role="tablist"
        aria-label={t(($) => $.create_issue.mode_tabs_aria)}
        className={TABLIST_CLASS}
      >
        {tab("agent")}
        {tab("manual")}
      </div>
      <div className="flex items-center gap-1">
        <DeferredTooltip
          side="bottom"
          content={expandLabel}
          trigger={
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              aria-label={expandLabel}
              className={ICON_BUTTON_CLASS}
            >
              {isExpanded ? <Minimize2 className="size-[15px]" /> : <Maximize2 className="size-[15px]" />}
            </button>
          }
        />
        <DeferredTooltip
          side="bottom"
          content={t(($) => $.common.close)}
          trigger={
            <button
              type="button"
              onClick={onClose}
              aria-label={t(($) => $.common.close)}
              className={ICON_BUTTON_CLASS}
            >
              <XIcon className="size-[15px]" />
            </button>
          }
        />
      </div>
    </div>
  );
}

/**
 * Icon for the property row's ⋯ overflow in both panels. Filled dots rather
 * than lucide's hairline ones, which all but vanish at 14px; colour comes
 * from the ghost pill, so it rests as muted as the other icon-only pills.
 */
export function MoreFieldsIcon() {
  return (
    <MoreHorizontal aria-hidden="true" className="size-3.5 fill-current" strokeWidth={2.4} />
  );
}

/**
 * Send-chord hint ("⌘ ↵") inside the primary create button, after its label.
 * Decorative (aria-hidden), so the button's accessible name stays its label.
 * Each key is a fixed 14px line-height-free box so the glyphs sit on the
 * label's centre line regardless of font metrics. Absent when `send` is
 * unbound, and hidden on phones, which have no ⌘ key.
 */
export function SendShortcutHint() {
  const sendShortcut = useShortcut("send");
  if (!sendShortcut) return null;
  return (
    <ShortcutKeycaps
      shortcut={sendShortcut}
      decorative
      className="ml-1 gap-0.5 opacity-60 max-sm:hidden"
      keyClassName="h-3.5 min-w-0 rounded-none border-0 bg-transparent px-0 shadow-none text-caption leading-none text-current [&_svg]:size-3"
    />
  );
}
