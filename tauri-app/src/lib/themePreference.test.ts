// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
  applyStoredAppThemePreference,
  readStoredAppTheme,
  rememberAppTheme,
} from './themePreference';

describe('theme preference', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, String(value)),
      },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
  });

  it('uses the stored theme before the system preference', () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, 'dark');

    expect(readStoredAppTheme()).toBe('dark');
  });

  it('applies the selected theme to the document root', () => {
    expect(applyAppTheme('dark')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    applyAppTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists changes and restores them during bootstrap', () => {
    rememberAppTheme('dark');
    document.documentElement.classList.remove('dark');

    expect(applyStoredAppThemePreference()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('uses a softened off-white foreground palette in dark mode', () => {
    const styles = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const darkTheme = styles.match(/\.dark\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? '';

    expect(darkTheme).toContain('--foreground: 0 0% 90%');
    expect(darkTheme).toContain('--card-foreground: 0 0% 90%');
    expect(darkTheme).toContain('--popover-foreground: 0 0% 90%');
  });
});
