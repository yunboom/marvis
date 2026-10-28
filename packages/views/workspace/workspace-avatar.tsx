import { resolvePublicFileUrl } from "@marvis/core/workspace/avatar-url";
import { cn } from "@marvis/ui/lib/utils";

// Rounded squares, not circles: circles are member avatars. `sm` is 18px so it
// sits in the sidebar's 18px icon column.
const sizeMap = {
  sm: "size-[18px] text-micro rounded-[5px]",
  md: "h-7 w-7 text-caption rounded-lg",
  lg: "h-9 w-9 text-body rounded-tile",
} as const;

interface WorkspaceAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: keyof typeof sizeMap;
  className?: string;
}

function WorkspaceAvatar({ name, avatarUrl, size = "sm", className }: WorkspaceAvatarProps) {
  const resolvedUrl = resolvePublicFileUrl(avatarUrl);
  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={name}
        className={cn("inline-block shrink-0 border object-cover", sizeMap[size], className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-foreground font-bold text-background",
        sizeMap[size],
        className
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export { WorkspaceAvatar, type WorkspaceAvatarProps };
