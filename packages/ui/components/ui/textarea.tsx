import * as React from "react"

import { cn } from "@marvis/ui/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-transparent bg-field hover:bg-field-hover focus-visible:bg-field-hover px-2.5 py-2 text-title-sm transition-colors outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-field disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
