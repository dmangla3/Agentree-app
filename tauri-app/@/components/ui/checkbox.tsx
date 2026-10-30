import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "../../../src/lib/utils"

type CheckboxIndicatorMode = "check" | "check-minus"

interface CheckboxProps extends React.ComponentProps<typeof CheckboxPrimitive.Root> {
  indicatorMode?: CheckboxIndicatorMode
}

function Checkbox({
  className,
  indicatorMode = "check-minus",
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "ui-checkbox peer border-input dark:bg-input/25 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/40 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-5 shrink-0 rounded-md border shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.04),0_1px_2px_hsl(var(--foreground)/0.04)] transition-[background-color,border-color,box-shadow,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] outline-none focus-visible:ring-[3px] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none data-[state=checked]:[&_.checkbox-minus]:hidden data-[state=indeterminate]:[&_.checkbox-check]:hidden"
      >
        <CheckIcon className="checkbox-check size-3.5" />
        {indicatorMode === "check-minus" ? <MinusIcon className="checkbox-minus size-3.5" /> : null}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
