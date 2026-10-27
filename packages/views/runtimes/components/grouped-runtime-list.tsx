import type { ReactNode } from "react";
import { Laptop } from "@phosphor-icons/react/ssr";
import { cn } from "@marvis/ui/lib/utils";
import type { AgentRuntime } from "@marvis/core/types";
import { groupRuntimesByMachine } from "@marvis/core/runtimes";
import { ProviderLogo } from "./provider-logo";
import { useT } from "../../i18n";

/**
 * Runtimes grouped under the machine they run on: the header names the host
 * and its status once, so each row only carries the tool and its version.
 * The selected row opens `selectedDetail` beneath it (the model choice).
 */
export function GroupedRuntimeList({
  runtimes,
  selectedId,
  onSelect,
  disabled = false,
  headerAction,
  selectedDetail,
}: {
  runtimes: AgentRuntime[];
  selectedId: string;
  onSelect: (runtimeId: string) => void;
  /** Set while a submit is in flight, so the choice cannot change under it. */
  disabled?: boolean;
  /** Rendered at the end of the first machine header (e.g. Refresh). */
  headerAction?: ReactNode;
  selectedDetail?: ReactNode;
}) {
  const { t: tAgents } = useT("agents");
  const groups = groupRuntimesByMachine(runtimes);

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group, index) => (
        <div
          key={group.key}
          role="radiogroup"
          aria-label={group.host || undefined}
          className="flex flex-col gap-0.5"
        >
          <div className="flex h-9 items-center gap-2 px-2.5 text-label text-muted-foreground">
            <Laptop weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {group.host ? (
              <span className="truncate font-semibold text-foreground">{group.host}</span>
            ) : null}
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                group.online ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span className="shrink-0">
              {group.online
                ? tAgents(($) => $.availability.online)
                : tAgents(($) => $.availability.offline)}
            </span>
            {index === 0 && headerAction ? (
              <span className="ml-auto">{headerAction}</span>
            ) : null}
          </div>

          {group.runtimes.map(({ runtime, label, version }) => {
            const selected = runtime.id === selectedId;
            return (
              <div
                key={runtime.id}
                className={cn(
                  "rounded-xl transition-[background-color,box-shadow] duration-(--motion-fast) ease-out",
                  selected && "bg-card shadow-[0_0_0_1.5px_var(--color-foreground)]",
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onSelect(runtime.id)}
                  className={cn(
                    "flex h-12 w-full items-center gap-3 rounded-xl pr-3.5 pl-2.5 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-60",
                    !selected && "hover:bg-card/60",
                  )}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-card shadow-[0_0_0_1px_var(--color-surface-border)]">
                    <ProviderLogo provider={runtime.provider} className="size-4" />
                  </span>
                  <span className="truncate text-body font-medium">{label}</span>
                  {version ? (
                    <span className="min-w-0 truncate text-caption text-muted-foreground">
                      {version}
                    </span>
                  ) : null}
                  <span
                    aria-hidden
                    className={cn(
                      "ml-auto size-[18px] shrink-0 rounded-full",
                      selected
                        ? "border-[5px] border-foreground"
                        : "border-[1.5px] border-input",
                    )}
                  />
                </button>
                {selected && selectedDetail ? (
                  <div className="pr-3.5 pb-3 pl-12">{selectedDetail}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
