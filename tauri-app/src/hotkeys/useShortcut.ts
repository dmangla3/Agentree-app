import { useEffect, useSyncExternalStore } from 'react';
import { matchesKeyboardEvent, normalizeRegisterableHotkey, parseHotkey, useHotkeys } from '@tanstack/react-hotkeys';
import {
  getEffectiveShortcutHotkeys,
  getShortcut,
  getShortcutDisplayLabels,
  getShortcutOverridesSnapshot,
  subscribeShortcutOverrides,
  type ShortcutId,
} from './shortcutRegistry';
import type { HotkeyCallback, RegisterableHotkey, UseHotkeyOptions } from '@tanstack/react-hotkeys';

export function useShortcut(
  id: ShortcutId,
  callback: HotkeyCallback,
  options: UseHotkeyOptions = {},
) {
  const shortcutOverrides = useSyncExternalStore(
    subscribeShortcutOverrides,
    getShortcutOverridesSnapshot,
    getShortcutOverridesSnapshot,
  );
  const shortcut = getShortcut(id);
  const hotkeys: RegisterableHotkey[] = getEffectiveShortcutHotkeys(id, shortcutOverrides);

  useHotkeys(
    hotkeys.map((hotkey) => ({
      hotkey,
      callback,
      options: {
        ...options,
        meta: {
          ...options.meta,
          name: shortcut.label,
          description: shortcut.description,
        },
      },
    })),
  );
}

export function useShortcutDisplayLabels(id: ShortcutId): string {
  const shortcutOverrides = useSyncExternalStore(
    subscribeShortcutOverrides,
    getShortcutOverridesSnapshot,
    getShortcutOverridesSnapshot,
  );
  return getShortcutDisplayLabels(getEffectiveShortcutHotkeys(id, shortcutOverrides));
}

export function useCapturedShortcut(
  id: ShortcutId,
  callback: HotkeyCallback,
  options: UseHotkeyOptions = {},
) {
  const shortcutOverrides = useSyncExternalStore(
    subscribeShortcutOverrides,
    getShortcutOverridesSnapshot,
    getShortcutOverridesSnapshot,
  );
  const hotkeys = getEffectiveShortcutHotkeys(id, shortcutOverrides);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const normalizedHotkeys = hotkeys.map((hotkey) => normalizeRegisterableHotkey(hotkey, options.platform));
    const handler = (event: KeyboardEvent) => {
      if (options.enabled === false) return;

      const matchedHotkey = normalizedHotkeys.find((hotkey) => (
        matchesKeyboardEvent(event, hotkey, options.platform)
      ));
      if (!matchedHotkey) return;

      if (options.preventDefault !== false) {
        event.preventDefault();
      }
      if (options.stopPropagation !== false) {
        event.stopPropagation();
      }
      callback(event, {
        hotkey: matchedHotkey,
        parsedHotkey: parseHotkey(matchedHotkey, options.platform),
      });
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [callback, hotkeys, options.enabled, options.platform, options.preventDefault, options.stopPropagation]);
}
