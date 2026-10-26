import { formatForDisplay, normalizeRegisterableHotkey } from '@tanstack/react-hotkeys';
import type { RegisterableHotkey } from '@tanstack/react-hotkeys';

export type ShortcutScope = 'global' | 'search' | 'graph' | 'integration';
export type ShortcutHotkey = RegisterableHotkey | RegisterableHotkey[];

export interface ShortcutDefinition {
  id: string;
  defaultHotkey: ShortcutHotkey;
  label: string;
  description: string;
  scope: ShortcutScope;
}

export const SHORTCUTS = {
  'thread.create': {
    id: 'thread.create',
    defaultHotkey: 'Mod+T',
    label: 'Start new thread',
    description: 'Create a new thread in the selected workspace.',
    scope: 'global',
  },
  'search.open': {
    id: 'search.open',
    defaultHotkey: 'Mod+K',
    label: 'Open search',
    description: 'Open the workspace search panel.',
    scope: 'global',
  },
  'search.close': {
    id: 'search.close',
    defaultHotkey: 'Escape',
    label: 'Close search',
    description: 'Close the active search panel.',
    scope: 'search',
  },
  'terminal.toggle': {
    id: 'terminal.toggle',
    defaultHotkey: 'Mod+J',
    label: 'Toggle terminal dock',
    description: 'Show or hide live terminals, or open one at the focused commit.',
    scope: 'global',
  },
  'app.font-size.increase': {
    id: 'app.font-size.increase',
    defaultHotkey: ['Mod+=', { key: '=', mod: true, shift: true }],
    label: 'Increase font size',
    description: 'Increase the app font size.',
    scope: 'global',
  },
  'app.font-size.decrease': {
    id: 'app.font-size.decrease',
    defaultHotkey: 'Mod+-',
    label: 'Decrease font size',
    description: 'Decrease the app font size.',
    scope: 'global',
  },
  'graph.selection.clear': {
    id: 'graph.selection.clear',
    defaultHotkey: 'Escape',
    label: 'Clear graph selection',
    description: 'Clear the current graph node selection.',
    scope: 'graph',
  },
  'graph.composer.close': {
    id: 'graph.composer.close',
    defaultHotkey: 'Escape',
    label: 'Close graph composer',
    description: 'Collapse the expanded graph composer.',
    scope: 'graph',
  },
  'graph.navigate.up': {
    id: 'graph.navigate.up',
    defaultHotkey: 'ArrowUp',
    label: 'Navigate graph up',
    description: 'Move focus to the nearest graph node above the current node.',
    scope: 'graph',
  },
  'graph.navigate.down': {
    id: 'graph.navigate.down',
    defaultHotkey: 'ArrowDown',
    label: 'Navigate graph down',
    description: 'Move focus to the nearest graph node below the current node.',
    scope: 'graph',
  },
  'graph.navigate.left': {
    id: 'graph.navigate.left',
    defaultHotkey: 'ArrowLeft',
    label: 'Navigate graph left',
    description: 'Move focus to the nearest graph node left of the current node.',
    scope: 'graph',
  },
  'graph.navigate.right': {
    id: 'graph.navigate.right',
    defaultHotkey: 'ArrowRight',
    label: 'Navigate graph right',
    description: 'Move focus to the nearest graph node right of the current node.',
    scope: 'graph',
  },
  'graph.navigate.previous': {
    id: 'graph.navigate.previous',
    defaultHotkey: '[',
    label: 'Previous graph node',
    description: 'Move focus to the previous graph node in chronological order.',
    scope: 'graph',
  },
  'graph.navigate.next': {
    id: 'graph.navigate.next',
    defaultHotkey: ']',
    label: 'Next graph node',
    description: 'Move focus to the next graph node in chronological order.',
    scope: 'graph',
  },
  'graph.navigate.latest': {
    id: 'graph.navigate.latest',
    defaultHotkey: 'End',
    label: 'Latest graph node',
    description: 'Move focus to the latest graph node.',
    scope: 'graph',
  },
  'thread.close': {
    id: 'thread.close',
    defaultHotkey: 'Mod+W',
    label: 'Close thread',
    description: 'Close the current thread.',
    scope: 'global',
  },
  'thread.reopen-last-closed': {
    id: 'thread.reopen-last-closed',
    defaultHotkey: 'Mod+Shift+T',
    label: 'Reopen last closed thread',
    description: 'Bring back the most recently closed thread.',
    scope: 'global',
  },
  'integration.embedded.close': {
    id: 'integration.embedded.close',
    defaultHotkey: 'Escape',
    label: 'Close embedded integration',
    description: 'Close the embedded integration workspace.',
    scope: 'integration',
  },
  'integration.workspace.close': {
    id: 'integration.workspace.close',
    defaultHotkey: 'Escape',
    label: 'Close integration workspace',
    description: 'Close the full integration workspace.',
    scope: 'integration',
  },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;
export type ShortcutOverrideMap = Partial<Record<ShortcutId, RegisterableHotkey>>;

const SHORTCUT_OVERRIDES_STORAGE_KEY = 'agentree.shortcut-overrides.v1';
const EMPTY_SHORTCUT_OVERRIDES: ShortcutOverrideMap = {};
const shortcutOverrideListeners = new Set<() => void>();
let shortcutOverrideSnapshot: ShortcutOverrideMap | null = null;

export const getShortcut = (id: ShortcutId): ShortcutDefinition => SHORTCUTS[id];

const isShortcutId = (value: string): value is ShortcutId => (
  Object.prototype.hasOwnProperty.call(SHORTCUTS, value)
);

const normalizeHotkeyList = (shortcut: ShortcutHotkey): RegisterableHotkey[] => (
  Array.isArray(shortcut) ? shortcut : [shortcut]
);

const readShortcutOverridesFromStorage = (): ShortcutOverrideMap => {
  if (typeof window === 'undefined') return EMPTY_SHORTCUT_OVERRIDES;

  try {
    const raw = window.localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    if (!raw) return EMPTY_SHORTCUT_OVERRIDES;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return EMPTY_SHORTCUT_OVERRIDES;
    }

    const overrides: ShortcutOverrideMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!isShortcutId(id) || typeof value !== 'string' || value.trim().length === 0) {
        continue;
      }
      overrides[id] = normalizeRegisterableHotkey(value.trim() as RegisterableHotkey);
    }
    return overrides;
  } catch {
    return EMPTY_SHORTCUT_OVERRIDES;
  }
};

const writeShortcutOverridesToStorage = (overrides: ShortcutOverrideMap): void => {
  if (typeof window === 'undefined') return;

  try {
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Shortcut overrides are a best-effort local preference.
  }
};

const publishShortcutOverrides = (overrides: ShortcutOverrideMap): void => {
  shortcutOverrideSnapshot = overrides;
  shortcutOverrideListeners.forEach((listener) => listener());
};

export const getShortcutOverridesSnapshot = (): ShortcutOverrideMap => {
  if (!shortcutOverrideSnapshot) {
    shortcutOverrideSnapshot = readShortcutOverridesFromStorage();
  }
  return shortcutOverrideSnapshot;
};

export const subscribeShortcutOverrides = (listener: () => void): (() => void) => {
  shortcutOverrideListeners.add(listener);
  return () => {
    shortcutOverrideListeners.delete(listener);
  };
};

export const getEffectiveShortcutHotkeys = (
  id: ShortcutId,
  overrides: ShortcutOverrideMap = getShortcutOverridesSnapshot(),
): RegisterableHotkey[] => {
  const override = overrides[id];
  return override ? [override] : normalizeHotkeyList(SHORTCUTS[id].defaultHotkey);
};

export const getShortcutDisplayLabel = (hotkey: RegisterableHotkey): string => (
  formatForDisplay(hotkey, { useSymbols: false })
);

export const getShortcutDisplayLabels = (hotkeys: RegisterableHotkey[]): string => (
  hotkeys.map(getShortcutDisplayLabel).join(' / ')
);

export const getDefaultShortcutDisplayLabels = (id: ShortcutId): string => (
  getShortcutDisplayLabels(normalizeHotkeyList(SHORTCUTS[id].defaultHotkey))
);

export const setShortcutOverride = (id: ShortcutId, hotkey: RegisterableHotkey): void => {
  const next: ShortcutOverrideMap = {
    ...getShortcutOverridesSnapshot(),
    [id]: normalizeRegisterableHotkey(hotkey),
  };
  writeShortcutOverridesToStorage(next);
  publishShortcutOverrides(next);
};

export const resetShortcutOverride = (id: ShortcutId): void => {
  const current = getShortcutOverridesSnapshot();
  if (!current[id]) return;
  const next = { ...current };
  delete next[id];
  writeShortcutOverridesToStorage(next);
  publishShortcutOverrides(next);
};

export const resetAllShortcutOverrides = (): void => {
  writeShortcutOverridesToStorage(EMPTY_SHORTCUT_OVERRIDES);
  publishShortcutOverrides(EMPTY_SHORTCUT_OVERRIDES);
};
