import type { AriaAttributes, ComponentType } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  Tray,
  ChatCircleDots,
  UserCircle,
  ListChecks,
  FolderSimple,
  FlowArrow,
  Lightning,
  Robot,
  UsersThree,
  ChartBar,
  Monitor,
  HardDrives,
  BookOpenText,
  Books,
  GearSix,
  File,
  FileText,
  FileImage,
  FileCode,
  FileArchive,
  FileAudio,
  FileVideo,
  FileDashed,
} from "@phosphor-icons/react/ssr";
import { resolveRouteIconName, type RouteIconName } from "@marvis/core/paths";

/** A navigation icon; callers size and colour it through `className`. */
export type RouteIcon = ComponentType<{
  className?: string;
  "aria-hidden"?: AriaAttributes["aria-hidden"];
}>;

/**
 * Route icons use the solid glyph style of Marvis.app: a filled shape in
 * currentColor with the details knocked out.
 */
export function filled(Glyph: PhosphorIcon): RouteIcon {
  function FilledIcon({
    className,
    "aria-hidden": ariaHidden = true,
  }: {
    className?: string;
    "aria-hidden"?: AriaAttributes["aria-hidden"];
  }) {
    return <Glyph weight="fill" className={className} aria-hidden={ariaHidden} />;
  }
  FilledIcon.displayName = `Filled${Glyph.displayName ?? ""}`;
  return FilledIcon;
}

/**
 * Icon name → component registry: the rendering half of the route icon
 * contract defined in `@marvis/core/paths`.
 *
 * Every {@link RouteIconName} must have an entry — the `Record` type makes a
 * missing key a compile error.
 */
export const ROUTE_ICON_COMPONENTS: Record<RouteIconName, RouteIcon> = {
  Inbox: filled(Tray),
  MessageSquare: filled(ChatCircleDots),
  CircleUser: filled(UserCircle),
  ListTodo: filled(ListChecks),
  FolderKanban: filled(FolderSimple),
  Workflow: filled(FlowArrow),
  Zap: filled(Lightning),
  Bot: filled(Robot),
  Users: filled(UsersThree),
  BarChart3: filled(ChartBar),
  Monitor: filled(Monitor),
  Server: filled(HardDrives),
  BookOpenText: filled(BookOpenText),
  Library: filled(Books),
  Settings: filled(GearSix),
  File: filled(File),
  FileText: filled(FileText),
  FileImage: filled(FileImage),
  FileCode: filled(FileCode),
  FileArchive: filled(FileArchive),
  FileAudio: filled(FileAudio),
  FileVideo: filled(FileVideo),
  FileQuestion: filled(FileDashed),
};

/**
 * Resolve the icon component for a workspace-scoped path or full tab URL.
 *
 * This is the only entry point navigation surfaces should use: it takes the
 * path they already have rather than an icon name, so no caller has to hold,
 * persist, or cast an icon name. `resolveRouteIconName` always returns a
 * valid name and the registry is total, so the result is never undefined — an
 * unknown route falls back to the default icon instead of rendering nothing.
 *
 * The sidebar nav and the desktop tab bar both call this, which is what keeps
 * a route's icon identical in both places.
 */
export function routeIconForPath(path: string): RouteIcon {
  return ROUTE_ICON_COMPONENTS[resolveRouteIconName(path)];
}
