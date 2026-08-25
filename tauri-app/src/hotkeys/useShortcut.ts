import { useHotkey } from '@tanstack/react-hotkeys';
import { getShortcut, type ShortcutId } from './shortcutRegistry';
import type { HotkeyCallback, UseHotkeyOptions } from '@tanstack/react-hotkeys';

export function useShortcut(
  id: ShortcutId,
  callback: HotkeyCallback,
  options: UseHotkeyOptions = {},
) {
  const shortcut = getShortcut(id);

  useHotkey(shortcut.defaultHotkey, callback, {
    ...options,
    meta: {
      ...options.meta,
      name: shortcut.label,
      description: shortcut.description,
    },
  });
}
