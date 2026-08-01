"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { cn } from "../../lib/utils"

// Define Theme type
type Theme = "light" | "dark";

export function ThemeToggle() {
  // State to hold the current theme
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem("theme") as Theme | "system";
      if (stored === "light" || stored === "dark") return stored;
      // Default based on system preference
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  });

  // Effect to apply the theme class to the HTML element and update localStorage
  React.useEffect(() => {
    const isDark = theme === "dark";

    // Apply/remove 'dark' class
    document.documentElement.classList.toggle("dark", isDark);

    // Persist theme choice
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Toggle between light and dark
  const toggleTheme = () => {
    setThemeState(prev => prev === "light" ? "dark" : "light");
  };

  // Modern icon button styles matching GraphControls
  const iconButtonBase = "group relative flex items-center justify-center rounded-lg transition-all duration-200 ease-out";
  const iconButtonGhost = "h-8 w-8 hover:bg-gradient-to-br hover:from-muted/80 hover:to-muted/40 hover:shadow-sm hover:shadow-black/5 active:scale-95";
  const iconContainer = "flex items-center justify-center transition-transform duration-200 group-hover:scale-110 group-active:scale-95";
  const iconGlow = "absolute inset-0 rounded-lg bg-gradient-to-br from-amber-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(iconButtonBase, iconButtonGhost, "relative overflow-hidden")}
      aria-label="Toggle theme"
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
    >
      <span className={iconGlow} />
      <span className={iconContainer}>
        {/* Sun icon - visible in light mode */}
        <Sun 
          className={cn(
            "h-[1.2rem] w-[1.2rem] transition-all duration-300",
            theme === "dark" ? "rotate-90 scale-0 opacity-0" : "rotate-0 scale-100 opacity-100 text-amber-500"
          )} 
        />
        {/* Moon icon - visible in dark mode */}
        <Moon 
          className={cn(
            "absolute h-[1.2rem] w-[1.2rem] transition-all duration-300",
            theme === "dark" ? "rotate-0 scale-100 opacity-100 text-indigo-400" : "-rotate-90 scale-0 opacity-0"
          )} 
        />
      </span>
    </button>
  )
}
