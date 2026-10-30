import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "../../../src/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-[100] max-w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel-strong)/0.98)] px-2.5 py-1.5 text-pretty text-[11px] font-medium leading-4 text-popover-foreground shadow-[0_12px_30px_-18px_hsl(var(--foreground)/0.42)] outline-none backdrop-blur-xl",
        "data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=delayed-open]:zoom-in-[0.98] data-[state=instant-open]:zoom-in-[0.98] data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 duration-150 [animation-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
