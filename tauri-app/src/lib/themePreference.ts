export const APP_THEME_STORAGE_KEY = 'theme';

export type AppTheme = 'light' | 'dark';

export function readStoredAppTheme(): AppTheme {
  try {
    const stored = typeof window !== 'undefined'
      ? window.localStorage?.getItem(APP_THEME_STORAGE_KEY)
      : null;
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Display preferences are best-effort when storage is unavailable.
  }

  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function applyAppTheme(theme: AppTheme, root?: HTMLElement | null): AppTheme {
  const target = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  target?.classList.toggle('dark', theme === 'dark');
  target?.setAttribute('data-theme', theme);
  return theme;
}

export function rememberAppTheme(theme: AppTheme): AppTheme {
  const applied = applyAppTheme(theme);
  try {
    window.localStorage?.setItem(APP_THEME_STORAGE_KEY, applied);
  } catch {
    // Display preferences are best-effort when storage is unavailable.
  }
  return applied;
}

export function applyStoredAppThemePreference(): AppTheme {
  return applyAppTheme(readStoredAppTheme());
}
