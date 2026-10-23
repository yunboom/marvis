"use client";

import type { ReactNode } from "react";
import type { AgentRuntime } from "@marvis/core/types";
import { ModelDropdown } from "../../agents/components/model-dropdown";
import { RuntimePicker } from "../../agents/components/runtime-picker";
import { CompactRuntimeRow } from "./compact-runtime-row";
import { GroupedRuntimeList } from "./grouped-runtime-list";

export interface MikaRuntimeSelection {
  runtimeId: string;
  /** Empty means "whatever the runtime defaults to". */
  model: string;
}

/**
 * The one place that asks "which runtime should Mika use, and on which model".
 *
 * Three surfaces reach this same decision — desktop onboarding, the web CLI
 * dialog, and the Runtimes page — and they had drifted: two offered a model
 * and one did not, so connecting via the web CLI silently created Mika on the
 * runtime's default model while desktop let you choose. Two of them also
 * re-implemented the reset rule below and the third simply lacked it.
 *
 * `layout` exists because the presentation genuinely differs, not because the
 * logic does. The CLI dialog lists machines because that is the moment they
 * appear one at a time after `marvis setup`, and a collapsed dropdown hides
 * exactly the feedback that dialog is there to give.
 */
export function MikaRuntimeChoice({
  runtimes,
  runtimesLoading,
  currentUserId = null,
  value,
  onChange,
  disabled = false,
  layout = "dropdown",
  modelLabel,
  headerAction,
}: {
  runtimes: AgentRuntime[];
  runtimesLoading?: boolean;
  /** Only used by the dropdown layout, to label runtime owners. */
  currentUserId?: string | null;
  value: MikaRuntimeSelection;
  onChange: (next: MikaRuntimeSelection) => void;
  disabled?: boolean;
  layout?: "dropdown" | "list" | "grouped";
  /** Heading above the model dropdown; omitted where the context names it. */
  modelLabel?: string;
  /** Grouped layout only: an action at the end of the first machine header. */
  headerAction?: ReactNode;
}) {
  const selected = runtimes.find((rt) => rt.id === value.runtimeId) ?? null;

  const selectRuntime = (runtimeId: string) => {
    // Models are per-runtime, so a value chosen for the previous runtime may
    // not exist on this one. Owned here so no caller can forget it.
    onChange({
      runtimeId,
      model: runtimeId === value.runtimeId ? value.model : "",
    });
  };

  const modelDropdown = (
    <ModelDropdown
      runtimeId={value.runtimeId || null}
      runtimeOnline={selected?.status === "online"}
      value={value.model}
      onChange={(model) => onChange({ ...value, model })}
      disabled={!value.runtimeId || disabled}
    />
  );

  // Grouped: machines head their runtimes and the model opens under the
  // selected row, so the whole choice reads as one list.
  if (layout === "grouped") {
    return (
      <GroupedRuntimeList
        runtimes={runtimes}
        selectedId={value.runtimeId}
        onSelect={selectRuntime}
        disabled={disabled}
        headerAction={headerAction}
        selectedDetail={
          <div className="flex items-center gap-3">
            {modelLabel ? (
              <span className="shrink-0 text-label text-muted-foreground">{modelLabel}</span>
            ) : null}
            <div className="min-w-0 flex-1">{modelDropdown}</div>
          </div>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {layout === "list" ? (
        // Capped at ~4 rows so the install commands above stay reachable when
        // a member has many machines registered.
        <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
          {runtimes.map((rt) => (
            <CompactRuntimeRow
              key={rt.id}
              runtime={rt}
              selected={rt.id === value.runtimeId}
              onSelect={() => selectRuntime(rt.id)}
              disabled={disabled}
            />
          ))}
        </div>
      ) : (
        <RuntimePicker
          runtimes={runtimes}
          runtimesLoading={runtimesLoading}
          members={[]}
          currentUserId={currentUserId}
          selectedRuntimeId={value.runtimeId}
          onSelect={selectRuntime}
          disabled={disabled}
        />
      )}
      <div className="flex flex-col gap-2">
        {modelLabel ? (
          <span className="mt-2 text-body font-medium">{modelLabel}</span>
        ) : null}
        {modelDropdown}
      </div>
    </div>
  );
}
