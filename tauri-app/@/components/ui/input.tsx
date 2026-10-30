import * as React from "react"

import { cn } from "../../../src/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "ui-input border-input file:text-foreground placeholder:text-muted-foreground/85 selection:bg-primary selection:text-primary-foreground dark:bg-input/25 flex h-9 w-full min-w-0 rounded-md border bg-background/78 px-3 py-1 text-base shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025),0_1px_2px_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow,background-color] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 md:text-sm",
        "focus-visible:border-primary/70 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/25",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/25 dark:aria-invalid:ring-destructive/45",
        className
      )}
      {...props}
    />
  )
}

export { Input }
