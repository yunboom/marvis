import {
  BookOpen,
  Box,
  Briefcase,
  Bug,
  Calendar,
  ChartLine,
  Cloud,
  Code,
  Compass,
  Database,
  Feather,
  FileText,
  Flag,
  Folder,
  GitBranch,
  Layers,
  Leaf,
  Lightbulb,
  Megaphone,
  Monitor,
  Mountain,
  Palette,
  PenTool,
  Rocket,
  Server,
  Shield,
  Smartphone,
  Sparkles,
  Target,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { parseProjectIcon, type ProjectGlyph } from "@marvis/core/projects/config";
import type { Project } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";

export type ProjectIconSize = "sm" | "md" | "lg";

export interface ProjectIconProps {
  project?: Pick<Project, "icon"> | null;
  size?: ProjectIconSize;
  className?: string;
}

export const PROJECT_GLYPH_COMPONENTS: Record<ProjectGlyph, LucideIcon> = {
  folder: Folder,
  briefcase: Briefcase,
  rocket: Rocket,
  target: Target,
  flag: Flag,
  compass: Compass,
  layers: Layers,
  box: Box,
  code: Code,
  terminal: Terminal,
  git_branch: GitBranch,
  database: Database,
  server: Server,
  cloud: Cloud,
  smartphone: Smartphone,
  monitor: Monitor,
  palette: Palette,
  pen_tool: PenTool,
  book_open: BookOpen,
  file_text: FileText,
  megaphone: Megaphone,
  chart_line: ChartLine,
  lightbulb: Lightbulb,
  sparkles: Sparkles,
  users: Users,
  shield: Shield,
  bug: Bug,
  wrench: Wrench,
  calendar: Calendar,
  mountain: Mountain,
  leaf: Leaf,
  feather: Feather,
};

const SIZE_CLASS: Record<ProjectIconSize, string> = {
  sm: "size-3.5 text-caption leading-none",
  md: "size-4 text-body leading-none",
  lg: "size-6 text-display-sm leading-none",
};

export function ProjectIcon({ project, size = "sm", className }: ProjectIconProps) {
  const icon = parseProjectIcon(project?.icon);
  const Glyph = PROJECT_GLYPH_COMPONENTS[icon?.kind === "glyph" ? icon.glyph : "folder"];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        SIZE_CLASS[size],
        className,
      )}
    >
      {icon?.kind === "emoji" ? (
        icon.emoji
      ) : (
        <Glyph data-project-glyph="" className="size-full" strokeWidth={1.75} />
      )}
    </span>
  );
}
