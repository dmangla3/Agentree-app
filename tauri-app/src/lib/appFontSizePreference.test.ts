// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_FONT_SIZE_STORAGE_KEY,
  DEFAULT_APP_FONT_SIZE_PX,
  MAX_APP_FONT_SIZE_PX,
  MIN_APP_FONT_SIZE_PX,
  applyAppFontSizePx,
  applyStoredAppFontSizePreference,
  changeAppFontSizePx,
  clampAppFontSizePx,
  readAppFontSizePx,
  rememberAppFontSizePx,
} from './appFontSizePreference';

describe('app font size preference', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => {
          values.delete(key);
        },
        setItem: (key: string, value: string) => {
          values.set(key, String(value));
        },
      },
    });
    document.documentElement.style.removeProperty('font-size');
    document.documentElement.style.removeProperty('--agentree-app-font-size');
    document.documentElement.removeAttribute('data-app-font-size');
  });

  it('clamps to the supported font size range', () => {
    expect(clampAppFontSizePx(8)).toBe(MIN_APP_FONT_SIZE_PX);
    expect(clampAppFontSizePx(18.4)).toBe(18);
    expect(clampAppFontSizePx(99)).toBe(MAX_APP_FONT_SIZE_PX);
    expect(clampAppFontSizePx(Number.NaN)).toBe(DEFAULT_APP_FONT_SIZE_PX);
  });

  it('applies the normalized font size to the document root', () => {
    const applied = applyAppFontSizePx(18);

    expect(applied).toBe(18);
    expect(document.documentElement.style.fontSize).toBe('18px');
    expect(document.documentElement.style.getPropertyValue('--agentree-app-font-size')).toBe('18px');
    expect(document.documentElement.getAttribute('data-app-font-size')).toBe('18');
  });

  it('reads the default when storage is missing or invalid', () => {
    expect(readAppFontSizePx()).toBe(DEFAULT_APP_FONT_SIZE_PX);

    window.localStorage.setItem(APP_FONT_SIZE_STORAGE_KEY, 'not-a-number');

    expect(readAppFontSizePx()).toBe(DEFAULT_APP_FONT_SIZE_PX);
  });

  it('persists normalized font sizes and restores them on boot', () => {
    expect(rememberAppFontSizePx(30)).toBe(MAX_APP_FONT_SIZE_PX);
    expect(window.localStorage.getItem(APP_FONT_SIZE_STORAGE_KEY)).toBe(String(MAX_APP_FONT_SIZE_PX));

    document.documentElement.style.removeProperty('font-size');

    expect(applyStoredAppFontSizePreference()).toBe(MAX_APP_FONT_SIZE_PX);
    expect(document.documentElement.style.fontSize).toBe(`${MAX_APP_FONT_SIZE_PX}px`);
  });

  it('steps up and down from the persisted value', () => {
    rememberAppFontSizePx(16);

    expect(changeAppFontSizePx(1)).toBe(17);
    expect(changeAppFontSizePx(-1)).toBe(16);
  });
});
