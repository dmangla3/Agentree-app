import { useSyncExternalStore } from 'react';
import { useHotkeys } from '@tanstack/react-hotkeys';
import {
  getEffectiveShortcutHotkeys,
  getShortcut,
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
