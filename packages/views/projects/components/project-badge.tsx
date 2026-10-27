"use client";

import { Check } from "lucide-react";
import {
  PROJECT_STATUS_CONFIG,
  PROJECT_STATUS_ORDER,
  PROJECT_PRIORITY_ORDER
} from "@marvis/core/projects/config";
import { cn } from "@marvis/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import type { Project, ProjectStatus, ProjectPriority, UpdateProjectRequest } from "@marvis/core/types";
import { PriorityIcon } from "../../issues/components/priority-icon";
import { useProjectStatusLabels, useProjectPriorityLabels } from "./labels";

// 状态药丸：状态色只给进行中 / 已完成，其余为中性灰；圆点承载状态色。
// 文字用状态色与前景色混合，保证浅色、暗色下都有足够对比度。
const STATUS_PILL: Record<ProjectStatus, { pill: string; dot: string }> = {
  planned: { pill: "bg-secondary text-muted-foreground", dot: "bg-faint-foreground" },
  in_progress: {
    pill: "bg-warning/15 text-[color-mix(in_oklab,var(--warning)_62%,var(--foreground))] dark:bg-warning/20",
    dot: "bg-warning",
  },
  paused: { pill: "bg-secondary text-muted-foreground", dot: "bg-faint-foreground" },
  completed: {
    pill: "bg-info/10 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))] dark:bg-info/20",
    dot: "bg-info",
  },
  cancelled: { pill: "bg-secondary text-muted-foreground", dot: "bg-destructive" },
};

// 优先级文字色：紧急为红，无优先级为次要灰，其余为前景色（图标随文字色）。
function priorityTextClass(priority: ProjectPriority): string {
  if (priority === "urgent") return "text-destructive";
  if (priority === "none") return "text-muted-foreground";

  return "text-foreground";
}

export function ProjectStatusBadge({ project, handleUpdate, triggerClassName, align = "end" }: { project: Project; handleUpdate: (data: UpdateProjectRequest) => void; triggerClassName?: string; align?: "start" | "end" | "center" }) {
  const statusLabels = useProjectStatusLabels();
  const statusPill = STATUS_PILL[project.status];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={cn(
            "inline-flex h-5.5 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.25 text-caption font-medium transition-opacity duration-(--motion-fast) ease-out hover:opacity-80 hover:duration-(--motion-instant)",
            statusPill.pill,
            triggerClassName
          )}>
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", statusPill.dot)} />
            {statusLabels[project.status]}
          </button>
        }
      />
      <DropdownMenuContent align={align} className="w-44">
        {PROJECT_STATUS_ORDER.map((s) => (
          <DropdownMenuItem key={s} onClick={() => handleUpdate({ status: s as ProjectStatus })}>
            <span className={cn("size-2 rounded-full", PROJECT_STATUS_CONFIG[s].dotColor)} />
            <span>{statusLabels[s]}</span>
            {s === project.status && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectPriorityBadge({ project, handleUpdate, triggerClassName, align = "end" }: { project: Project; handleUpdate: (data: UpdateProjectRequest) => void; triggerClassName?: string; align?: "start" | "end" | "center" }) {
  const priorityLabels = useProjectPriorityLabels();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={cn(
            "-ml-1.5 inline-flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-row px-1.5 text-caption transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:duration-(--motion-instant) data-popup-open:bg-accent",
            priorityTextClass(project.priority),
            triggerClassName
          )}>
            <PriorityIcon priority={project.priority} inheritColor />
            <span>{priorityLabels[project.priority]}</span>
          </button>
        }
      />
      <DropdownMenuContent align={align} className="w-44">
        {PROJECT_PRIORITY_ORDER.map((p) => (
          <DropdownMenuItem key={p} onClick={() => handleUpdate({ priority: p as ProjectPriority })}>
            <PriorityIcon priority={p} />
            <span>{priorityLabels[p]}</span>
            {p === project.priority && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
