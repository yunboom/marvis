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
import {
  DEFAULT_PROJECT_ICON,
  parseProjectIcon,
  type ProjectIconKey,
} from "@marvis/core/projects/config";
import type { Project } from "@marvis/core/types";
import { cn } from "@marvis/ui/lib/utils";

export type ProjectIconSize = "sm" | "md" | "tile";

export interface ProjectIconProps {
  project?: Pick<Project, "icon"> | null;
  size?: ProjectIconSize;
  className?: string;
}

export const PROJECT_ICON_COMPONENTS: Record<ProjectIconKey, LucideIcon> = {
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
  "git-branch": GitBranch,
  database: Database,
  server: Server,
  cloud: Cloud,
  smartphone: Smartphone,
  monitor: Monitor,
  palette: Palette,
  "pen-tool": PenTool,
  "book-open": BookOpen,
  "file-text": FileText,
  megaphone: Megaphone,
  "chart-line": ChartLine,
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

// `tile` sits beside a project title: the glyph on the neutral avatar square.
const BOX_CLASS: Record<ProjectIconSize, string> = {
  sm: "size-3.5",
  md: "size-4",
  tile: "size-10 rounded-[28%] bg-identity-gray text-identity-gray-foreground",
};

const GLYPH_CLASS: Record<ProjectIconSize, string> = {
  sm: "size-full",
  md: "size-full",
  tile: "size-5",
};

export function ProjectIcon({ project, size = "sm", className }: ProjectIconProps) {
  const Glyph = PROJECT_ICON_COMPONENTS[parseProjectIcon(project?.icon) ?? DEFAULT_PROJECT_ICON];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        BOX_CLASS[size],
        className,
      )}
    >
      <Glyph className={GLYPH_CLASS[size]} strokeWidth={1.75} />
    </span>
  );
}
