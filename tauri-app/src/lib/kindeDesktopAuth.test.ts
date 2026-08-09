import { describe, expect, test } from 'vitest';
import { shouldUseDesktopBrowserAuth } from './kindeDesktopAuth';

describe('kinde desktop auth runtime detection', () => {
  test('uses desktop browser auth when Tauri exposes the legacy window marker', () => {
    const fakeWindow = {};
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(fakeWindow, '__TAURI__', {
      configurable: true,
      value: {},
    });

    expect(shouldUseDesktopBrowserAuth()).toBe(true);

    Reflect.deleteProperty(globalThis, 'window');
  });
});
