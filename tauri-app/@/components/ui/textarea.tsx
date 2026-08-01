import * as React from "react"

import { cn } from "../../../src/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[border-color,box-shadow,background-color] duration-150 ease-in-out outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0", // Refined focus
        "aria-invalid:ring-destructive/40 dark:aria-invalid:ring-destructive/60 aria-invalid:border-destructive", // Enhanced invalid state
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
