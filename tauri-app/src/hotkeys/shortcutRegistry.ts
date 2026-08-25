import type { RegisterableHotkey } from '@tanstack/react-hotkeys';

export type ShortcutScope = 'global' | 'search' | 'graph' | 'integration';

export interface ShortcutDefinition {
  id: string;
  defaultHotkey: RegisterableHotkey;
  label: string;
  description: string;
  scope: ShortcutScope;
}

export const SHORTCUTS = {
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

export const getShortcut = (id: ShortcutId): ShortcutDefinition => SHORTCUTS[id];
