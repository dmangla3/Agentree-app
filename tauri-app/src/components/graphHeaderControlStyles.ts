export const graphHeaderControlClass = [
  "app-focus-ring relative flex h-8 min-w-10 items-center justify-center gap-1.5 rounded-md",
  "border border-border/80 bg-background/88 px-2.5 text-xs font-medium tracking-[-0.01em] text-foreground",
  "shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]",
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
  "hover:border-border hover:bg-accent hover:text-accent-foreground active:scale-[0.96]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "after:absolute after:left-1/2 after:top-1/2 after:h-10 after:w-full after:min-w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
  "motion-reduce:transition-none dark:bg-input/25 dark:hover:bg-input/45",
].join(' ');

export const graphHeaderControlSelectedClass =
  "border-[hsl(var(--app-border-strong)/0.8)] bg-[hsl(var(--app-bg-muted)/0.82)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.035)]";

export const graphHeaderControlIconClass = "h-3.5 w-3.5 shrink-0";
export const graphHeaderControlLabelClass = "hidden text-xs font-medium sm:inline";
