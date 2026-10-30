"use client"

import * as React from "react"
import { Moon, Sun } from "@phosphor-icons/react"
import { FillIcon } from "../RailIcon"
import { cn } from "../../lib/utils"
import { readStoredAppTheme, rememberAppTheme, type AppTheme } from "../../lib/themePreference"

export function ThemeToggle() {
  const [theme, setThemeState] = React.useState<AppTheme>(readStoredAppTheme);

  // Effect to apply the theme class to the HTML element and update localStorage
  React.useEffect(() => {
    rememberAppTheme(theme);
  }, [theme]);

  // Toggle between light and dark
  const toggleTheme = () => {
    setThemeState(prev => prev === "light" ? "dark" : "light");
  };

  const iconButtonBase = "app-fill-icon-trigger group relative flex size-9 items-center justify-center overflow-hidden rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-accent hover:text-foreground active:scale-[0.96] motion-reduce:transition-none";
  const visibleIcon = "scale-100 opacity-100 blur-0";
  const hiddenIcon = "scale-[0.25] opacity-0 blur-[4px]";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={iconButtonBase}
      aria-label="Toggle theme"
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
    >
      <span className="relative flex h-[18px] w-[18px] items-center justify-center leading-none">
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center text-amber-600 transition-[opacity,filter,transform] duration-200 [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
            theme === "dark" ? hiddenIcon : visibleIcon
          )}
        >
          <FillIcon icon={Sun} size={18} />
        </span>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center text-primary transition-[opacity,filter,transform] duration-200 [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
            theme === "dark" ? visibleIcon : hiddenIcon
          )}
        >
          <FillIcon icon={Moon} size={18} />
        </span>
      </span>
    </button>
  )
}
