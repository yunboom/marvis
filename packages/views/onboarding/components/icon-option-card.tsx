"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";

const OTHER_INPUT_MAX_LENGTH = 80;

/**
 * One option in a questionnaire card grid. `slug` is the persisted
 * enum value; `icon` is a React node (lucide icon, brand SVG, or emoji
 * span); `label` is the localized string already resolved by the
 * caller. `isOther` flips this card into a free-text input row.
 *
 * Shared by the About-you onboarding step and the workspace
 * source-backfill prompt, which both render their options through the
 * cards below.
 */
export interface QuestionOption {
  slug: string;
  icon: ReactNode;
  label: string;
  isOther?: boolean;
}

// 选项药丸：40 高、14 内边距、常规字重；选中时主色描边 + 浅灰底。
const OPTION_CHIP_CLASS = "gap-2 px-3.5 font-normal";
const OPTION_CHIP_SELECTED_CLASS =
  "border-foreground bg-surface-selected hover:bg-surface-selected";

/**
 * A questionnaire option, rendered as a wrapping chip.
 *
 * These used to be full-width bordered cards in a 4-column grid. Inside the
 * onboarding column that grid had nowhere to go, and stacking 18 options as
 * full-width rows turned one screen into a long scroll. Chips are the block's
 * own answer for a many-option question, and they wrap to fit whatever width
 * the column has.
 *
 * `mode` controls ARIA role: `"radio"` for single-select questions
 * (role, source), `"checkbox"` for multi-select (use case). Visual
 * style is identical — the tinted border already conveys "selected";
 * multi-select chips just additionally don't deselect other chips when
 * clicked, which is the parent's responsibility.
 */
export function IconOptionCard({
  icon,
  label,
  selected,
  onSelect,
  mode = "radio",
}: {
  icon: ReactNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
  mode?: "radio" | "checkbox";
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      role={mode}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(OPTION_CHIP_CLASS, selected && OPTION_CHIP_SELECTED_CLASS)}
    >
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center text-muted-foreground [&_svg]:size-4",
          selected && "text-foreground",
        )}
      >
        {icon}
      </span>
      <span>{label}</span>
      {selected ? <Check aria-hidden className="size-4 shrink-0" /> : null}
    </Button>
  );
}

/**
 * "Other" variant — the same chip, but when selected its label slot becomes a
 * borderless input that inherits the chip's typography, so the row keeps the
 * same weight as its neighbours instead of jumping to a full-width field.
 * Auto-focuses on open; Enter triggers the parent's `onConfirm`.
 */
export function IconOtherOptionCard({
  icon,
  label,
  selected,
  onSelect,
  otherValue,
  onOtherChange,
  onConfirm,
  placeholder,
  mode = "radio",
}: {
  icon: ReactNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
  otherValue: string;
  onOtherChange: (value: string) => void;
  onConfirm: () => void;
  placeholder: string;
  mode?: "radio" | "checkbox";
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      role={mode}
      aria-checked={selected}
      onClick={() => {
        if (!selected) onSelect();
      }}
      className={cn(OPTION_CHIP_CLASS, selected && OPTION_CHIP_SELECTED_CLASS)}
    >
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center text-muted-foreground [&_svg]:size-4",
          selected && "text-foreground",
        )}
      >
        {icon}
      </span>
      {selected ? (
        <input
          autoFocus
          type="text"
          value={otherValue}
          onChange={(e) => onOtherChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && otherValue.trim()) {
              e.preventDefault();
              onConfirm();
            }
          }}
          placeholder={placeholder}
          maxLength={OTHER_INPUT_MAX_LENGTH}
          aria-label={placeholder}
          className="w-38 min-w-0 border-0 bg-transparent p-0 text-inherit placeholder:text-muted-foreground focus:outline-none"
        />
      ) : (
        <span>{label}</span>
      )}
    </Button>
  );
}

export { OTHER_INPUT_MAX_LENGTH };
