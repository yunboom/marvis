"use client";

import { Check, ChevronDown, Lock } from "lucide-react";
import { isRuntimeUsableForUser, runtimeDisplayLabel } from "@marvis/core/runtimes";
import type { MemberWithUser, RuntimeDevice } from "@marvis/core/types";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { Popover, PopoverContent, PopoverTrigger } from "@marvis/ui/components/ui/popover";
import { cn } from "@marvis/ui/lib/utils";
import { ModelDropdown } from "../../agents/components/model-dropdown";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { splitRuntimeName } from "../../runtimes/components/runtime-machines";

/** A runtime's own name and the machine it runs on, shown as two parts. */
function runtimeNameParts(runtime: RuntimeDevice): { name: string; machine: string } {
  const custom = runtime.custom_name?.trim();
  const { base, hostname } = splitRuntimeName(runtime.name);
  const machine = hostname ?? runtime.device_info?.split(" · ")[0]?.trim() ?? "";

  return { name: custom || base, machine: machine && machine !== custom ? machine : "" };
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/40")}
    />
  );
}

/**
 * Where the builder conversation runs (design: runtime menu). The
 * member's own runtimes come first, then the ones others share; offline ones
 * are greyed and private ones not shared with this member are locked. What a
 * pick does is the caller's: before a conversation exists it only changes the
 * selection, afterwards it rebinds the conversation.
 */
function KbRuntimeMenu({
  runtimes,
  members,
  currentUserId,
  runtimeId,
  lastUsedId,
  disabled,
  open,
  onOpenChange,
  onSelect,
  connectHref,
}: {
  runtimes: RuntimeDevice[];
  members: MemberWithUser[];
  currentUserId: string | null;
  runtimeId: string;
  lastUsedId: string | undefined;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (runtimeId: string) => void;
  connectHref: string;
}) {
  const { t } = useT("kb");
  const current = runtimes.find((runtime) => runtime.id === runtimeId) ?? null;
  const currentOnline = current?.status === "online";
  const mine = runtimes.filter((runtime) => runtime.owner_id === currentUserId);
  const others = runtimes.filter((runtime) => runtime.owner_id !== currentUserId);
  const ownerName = (ownerId: string | null) =>
    members.find((member) => member.user_id === ownerId)?.name ?? "";
  const label = current ? runtimeDisplayLabel(current) : t(($) => $.builder.runtime.none);
  const currentParts = current ? runtimeNameParts(current) : null;

  const row = (runtime: RuntimeDevice) => {
    const usable = isRuntimeUsableForUser(runtime, currentUserId);
    const online = runtime.status === "online";
    const selectable = usable && online;
    const selected = runtime.id === runtimeId;
    const owner = runtime.owner_id === currentUserId ? "" : ownerName(runtime.owner_id);
    const lockedReason = usable
      ? undefined
      : owner
        ? t(($) => $.builder.runtime.locked, { owner })
        : t(($) => $.builder.runtime.locked_unnamed);
    const detail = [owner || runtime.device_info, online ? t(($) => $.builder.runtime.online) : t(($) => $.builder.runtime.offline)]
      .filter(Boolean)
      .join(" · ");

    return (
      <TooltipHint key={runtime.id} label={lockedReason}>
        <button
          type="button"
          role="option"
          aria-selected={selected}
          aria-disabled={!selectable || undefined}
          onClick={() => {
            if (!selectable) return;
            onSelect(runtime.id);
            onOpenChange(false);
          }}
          className={cn(
            "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body transition-colors",
            selectable ? (selected ? "bg-accent" : "hover:bg-accent/50") : "cursor-not-allowed opacity-50",
          )}
        >
          <StatusDot online={online} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{runtimeDisplayLabel(runtime)}</span>
            <span className="truncate text-caption text-muted-foreground">{detail}</span>
          </span>
          {runtime.id === lastUsedId && (
            <span className="shrink-0 text-micro text-faint-foreground">{t(($) => $.builder.runtime.last_used)}</span>
          )}
          {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
          {!usable && <Lock aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />}
        </button>
      </TooltipHint>
    );
  };

  const group = (title: string, items: RuntimeDevice[]) =>
    items.length > 0 ? (
      <div role="group" aria-label={title}>
        <div className="px-2.5 pt-2 pb-1 text-caption text-faint-foreground">{title}</div>
        {items.map(row)}
      </div>
    ) : null;

  return (
    <Popover open={open && !disabled} onOpenChange={(next) => !disabled && onOpenChange(next)}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${t(($) => $.builder.runtime.label)}: ${label}`}
        title={label}
        className="flex h-7.5 max-w-55 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-left text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <StatusDot online={currentOnline} />
        {/* One truncating line, so a long machine name gives way first. */}
        <span className="min-w-0 truncate">
          {currentParts ? (
            <>
              <span className="text-foreground">{currentParts.name}</span>
              {currentParts.machine && <span> · {currentParts.machine}</span>}
            </>
          ) : (
            label
          )}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="flex max-h-96 w-80 max-w-[calc(100vw-2rem)] flex-col p-1"
      >
        <div role="listbox" aria-label={t(($) => $.builder.runtime.menu_label)} className="min-h-0 flex-1 overflow-y-auto">
          {group(t(($) => $.builder.runtime.mine), mine)}
          {group(t(($) => $.builder.runtime.others), others)}
        </div>
        <div className="mx-1 my-1 h-px shrink-0 bg-border" />
        <AppLink
          href={connectHref}
          className="shrink-0 rounded-md px-2.5 py-2 text-body text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {t(($) => $.builder.runtime.connect)}
        </AppLink>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Where the builder runs: the runtime menu and, before the conversation
 * starts, the model, as one self-contained pair of pills. The caller only
 * places the pair (today: the composer toolbar).
 */
export function KbRuntimeControls({
  runtimes,
  members,
  currentUserId,
  runtimeId,
  lastUsedId,
  runtimeDisabled,
  menuOpen,
  onMenuOpenChange,
  onRuntimeSelect,
  connectHref,
  model,
  className,
}: {
  runtimes: RuntimeDevice[];
  members: MemberWithUser[];
  currentUserId: string | null;
  runtimeId: string;
  lastUsedId: string | undefined;
  runtimeDisabled: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onRuntimeSelect: (runtimeId: string) => void;
  connectHref: string;
  /** The model picker; omitted once the model is frozen onto a conversation. */
  model?: { value: string; onChange: (value: string) => void; disabled: boolean };
  className?: string;
}) {
  const runtime = runtimes.find((item) => item.id === runtimeId) ?? null;

  return (
    <div className={cn("flex min-w-0 items-center gap-0.5", className)}>
      <KbRuntimeMenu
        runtimes={runtimes}
        members={members}
        currentUserId={currentUserId}
        runtimeId={runtimeId}
        lastUsedId={lastUsedId}
        disabled={runtimeDisabled}
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        onSelect={onRuntimeSelect}
        connectHref={connectHref}
      />
      {model && (
        <ModelDropdown
          compact
          runtimeId={runtime?.id ?? null}
          runtimeOnline={runtime?.status === "online"}
          value={model.value}
          onChange={model.onChange}
          disabled={model.disabled}
        />
      )}
    </div>
  );
}
