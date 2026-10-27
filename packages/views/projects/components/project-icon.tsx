import { Kanban } from "@phosphor-icons/react/ssr";
import type { Project } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";

export type ProjectIconSize = "sm" | "md" | "lg";

export interface ProjectIconProps {
  project?: Pick<Project, "icon"> | null;
  size?: ProjectIconSize;
  className?: string;
}

const SIZE_CLASS: Record<ProjectIconSize, string> = {
  sm: "size-3.5 text-caption leading-none",
  md: "size-4 text-body leading-none",
  lg: "size-6 text-display-sm leading-none",
};

// Projects without an emoji show a solid kanban glyph.
export function ProjectIcon({ project, size = "sm", className }: ProjectIconProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        SIZE_CLASS[size],
        className,
      )}
    >
      {project?.icon || (
        <Kanban weight="fill" className="size-full text-muted-foreground" />
      )}
    </span>
  );
}
