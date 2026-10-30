import * as React from "react"

import { cn } from "../../../src/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "ui-textarea border-input placeholder:text-muted-foreground/85 dark:bg-input/25 flex field-sizing-content min-h-18 w-full rounded-md border bg-background/78 px-3 py-2 text-base shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025),0_1px_2px_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow,background-color] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] outline-none disabled:cursor-not-allowed disabled:opacity-45 md:text-sm",
        "focus-visible:border-primary/70 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/25",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/25 dark:aria-invalid:ring-destructive/45",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
