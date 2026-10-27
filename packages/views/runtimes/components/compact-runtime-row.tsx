import { cn } from "@marvis/ui/lib/utils";
import type { AgentRuntime } from "@marvis/core/types";
import { runtimeDisplayName } from "@marvis/core/runtimes";
import { ProviderLogo } from "./provider-logo";
import { useT } from "../../i18n";

/**
 * One selectable runtime card: provider logo, name, online status with the
 * host it runs on, and a radio mark. Selection state is driven by the caller
 * so every surface that picks Mika's runtime shares one row.
 */
export function CompactRuntimeRow({
  runtime,
  selected,
  onSelect,
  disabled = false,
}: {
  runtime: AgentRuntime;
  selected: boolean;
  onSelect: () => void;
  /** Set while a submit is in flight, so the choice cannot change under it. */
  disabled?: boolean;
}) {
  const { t: tAgents } = useT("agents");
  const online = runtime.status === "online";
  const host = (runtime.device_info ?? "").trim();

  return (
    // A real button rather than role="button": it brings disabled, focus, and
    // Enter/Space for free. The hand-rolled keydown branch this replaces did
    // not honour disabled at all, so a member could switch runtimes mid-submit
    // and end up with Mika on a machine they no longer had selected.
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex h-16 w-full shrink-0 items-center gap-3 rounded-xl border bg-card px-4 text-left transition-[border-color,box-shadow] duration-(--motion-fast) ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60",
        selected
          ? "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]"
          : "border-surface-border hover:border-input",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-sunken">
        <ProviderLogo provider={runtime.provider} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-lg font-medium">
          {runtimeDisplayName(runtime)}
        </span>
        <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              online ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
          <span className="truncate">
            {online
              ? tAgents(($) => $.availability.online)
              : tAgents(($) => $.availability.offline)}
            {host ? ` · ${host}` : null}
          </span>
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "size-[18px] shrink-0 rounded-full",
          selected
            ? "border-[5px] border-foreground"
            : "border-[1.5px] border-input",
        )}
      />
    </button>
  );
}
