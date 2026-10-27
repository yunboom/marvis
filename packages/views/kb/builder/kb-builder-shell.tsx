"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { isRuntimeUsableForUser, runtimeDisplayLabel } from "@marvis/core/runtimes";
import type { RuntimeDevice } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { AgentCreateChip, AgentCreateShell } from "../../agents/create/create-shell";
import { useT } from "../../i18n";

/**
 * The runtime the conversation runs on, with "Change" next to it (designs 1.9
 * and 10.x). Only online runtimes this member may use are offered; the switch
 * itself is the caller's, because it must rebind the carrier first.
 */
export function KbRuntimeChip({
  runtimes,
  currentUserId,
  runtimeId,
  disabled,
  onSwitch,
}: {
  runtimes: RuntimeDevice[];
  currentUserId: string | null;
  runtimeId: string;
  disabled: boolean;
  onSwitch: (runtimeId: string) => void;
}) {
  const { t } = useT("kb");
  const current = runtimes.find((runtime) => runtime.id === runtimeId) ?? null;
  const usable = runtimes.filter(
    (runtime) => runtime.status === "online" && isRuntimeUsableForUser(runtime, currentUserId),
  );

  if (!current) return null;

  return (
    <AgentCreateChip>
      <span className="truncate">{runtimeDisplayLabel(current)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              aria-label={t(($) => $.builder.change_runtime_label)}
              className="h-5 px-1.5"
            />
          }
        >
          {t(($) => $.builder.change_runtime)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {usable.map((runtime) => (
            <DropdownMenuItem key={runtime.id} onClick={() => onSwitch(runtime.id)}>
              <span className="min-w-0 flex-1 truncate">{runtimeDisplayLabel(runtime)}</span>
              {runtime.id === runtimeId && <Check aria-hidden="true" className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </AgentCreateChip>
  );
}

/** Chrome of the builder routes: back, the flow title, and context chips. */
export function KbBuilderShell({
  creating,
  subtitle,
  onBack,
  runtimeChip,
  children,
}: {
  creating: boolean;
  /** Under the title: "Create through conversation", or the base's name. */
  subtitle: string;
  onBack: () => void;
  runtimeChip?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT("kb");

  return (
    <AgentCreateShell
      title={creating ? t(($) => $.builder.create_title) : t(($) => $.builder.config_title)}
      step={subtitle}
      onBack={onBack}
      chips={
        <>
          <AgentCreateChip>{t(($) => $.builder.via_chat)}</AgentCreateChip>
          {runtimeChip}
        </>
      }
    >
      {children}
    </AgentCreateShell>
  );
}
