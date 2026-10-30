import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../../src/lib/utils"

const buttonVariants = cva(
  "ui-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium tracking-[-0.01em] transition-[background-color,color,box-shadow,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-destructive/20 active:scale-[0.96] dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_0_0_1px_hsl(var(--primary)/0.12),0_1px_2px_hsl(var(--foreground)/0.12)] hover:bg-primary/92 hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.18),0_2px_5px_hsl(var(--foreground)/0.14)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/50 dark:focus-visible:ring-destructive/70 dark:bg-destructive/80 dark:text-white",
        outline:
          "border border-border/80 bg-background/88 shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] hover:border-border hover:bg-accent hover:text-accent-foreground dark:bg-input/25 dark:hover:bg-input/45",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 py-2 has-[>svg]:pl-3.5 has-[>svg]:pr-3",
        sm: "h-8 gap-1.5 px-2.5 has-[>svg]:pl-2.5 has-[>svg]:pr-2",
        lg: "h-10 px-4.5 has-[>svg]:pl-4.5 has-[>svg]:pr-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
