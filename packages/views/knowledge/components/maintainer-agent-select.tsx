"use client";

import type { Agent } from "@marvis/core/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@marvis/ui/components/ui/select";
import { useT } from "../../i18n";

const NONE = "__none__";

export function MaintainerAgentSelect({
  id,
  agents,
  value,
  onChange,
  disabled,
}: {
  id: string;
  agents: Agent[];
  value: string | null;
  onChange: (agentId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT("knowledge");
  const items = [
    { value: NONE, label: t(($) => $.fields.maintainer_none) },
    ...agents.filter((a) => !a.archived_at).map((a) => ({ value: a.id, label: a.name })),
  ];
  const current = items.find((i) => i.value === (value ?? NONE)) ?? items[0];

  return (
    <Select
      items={items}
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE || next == null ? null : String(next))}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{() => current?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
