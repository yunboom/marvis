import { cn } from "@marvis/ui/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-skeleton-shimmer rounded-md bg-skeleton", className)}
      {...props}
    />
  )
}

export { Skeleton }
