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
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
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
