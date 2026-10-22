"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@marvis/ui/lib/utils"

function TooltipProvider({
  delay = 200,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
  >) {
  // The tooltip inverts the page theme. The popup is a `.dark` scope, so on
  // a light page its text, status colors, and keycaps take dark-theme values
  // against the near-black surface; on a dark page base.css re-scopes it to
  // the light values against the near-white surface. Its own fill and shadow
  // are resolved on the positioner, which is still in the page theme.
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        className="isolate z-50 [--tooltip-fill:var(--tooltip)] [--tooltip-elevation:var(--tooltip-shadow)]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "dark z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-row bg-(--tooltip-fill) px-2.5 py-1.5 text-caption font-medium text-foreground shadow-(--tooltip-elevation) has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[side=top]:[--tooltip-nudge-y:-2px] data-[side=bottom]:[--tooltip-nudge-y:2px] data-[side=left]:[--tooltip-nudge-x:-2px] data-[side=right]:[--tooltip-nudge-x:2px] data-[state=delayed-open]:animate-[tooltip-in_var(--motion-fast)_var(--ease-out)] data-open:animate-[tooltip-in_var(--motion-fast)_var(--ease-out)] data-closed:animate-[overlay-fade-out_var(--motion-instant)_var(--ease-in)_forwards]",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
