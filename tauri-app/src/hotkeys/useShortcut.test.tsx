// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllShortcutOverrides, setShortcutOverride } from './shortcutRegistry';
import { useCapturedShortcut } from './useShortcut';
import type { RegisterableHotkey } from '@tanstack/react-hotkeys';

describe('useCapturedShortcut', () => {
  const storageValues = new Map<string, string>();
  const localStorage = {
    clear: () => storageValues.clear(),
    getItem: (key: string) => storageValues.get(key) ?? null,
    removeItem: (key: string) => {
      storageValues.delete(key);
    },
    setItem: (key: string, value: string) => {
      storageValues.set(key, value);
    },
  };

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorage,
    });
    window.localStorage.clear();
    resetAllShortcutOverrides();
  });

  it('prevents native defaults before bubbling handlers run', () => {
    const callback = vi.fn();
    const bubbleListener = vi.fn();
    renderHook(() => useCapturedShortcut('thread.close', callback, { platform: 'mac' }));
    document.addEventListener('keydown', bubbleListener);

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'w',
      code: 'KeyW',
      metaKey: true,
    });

    window.dispatchEvent(event);

    expect(callback).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(bubbleListener).not.toHaveBeenCalled();

    document.removeEventListener('keydown', bubbleListener);
  });

  it('uses shortcut overrides in the capture listener', () => {
    const callback = vi.fn();
    setShortcutOverride('thread.close', 'Mod+Shift+W' as RegisterableHotkey);
    renderHook(() => useCapturedShortcut('thread.close', callback, { platform: 'mac' }));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'w',
      code: 'KeyW',
      metaKey: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'W',
      code: 'KeyW',
      metaKey: true,
      shiftKey: true,
    }));

    expect(callback).toHaveBeenCalledOnce();
  });
});
