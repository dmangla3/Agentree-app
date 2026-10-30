import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEffectiveShortcutHotkeys,
  getShortcutDisplayLabels,
  getShortcutOverridesSnapshot,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride,
} from './shortcutRegistry';
import type { RegisterableHotkey } from '@tanstack/react-hotkeys';

describe('shortcut registry overrides', () => {
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
    vi.stubGlobal('window', { localStorage });
    localStorage.clear();
    resetAllShortcutOverrides();
  });

  it('uses defaults until an override is saved', () => {
    expect(getEffectiveShortcutHotkeys('search.open')).toEqual(['Mod+K']);

    setShortcutOverride('search.open', 'Mod+Shift+K' as RegisterableHotkey);

    expect(getShortcutDisplayLabels(getEffectiveShortcutHotkeys('search.open'))).toContain('Shift+K');
    expect(getShortcutOverridesSnapshot()['search.open']).toContain('Shift+K');
  });

  it('registers thread close and reopen defaults', () => {
    expect(getEffectiveShortcutHotkeys('thread.close')).toEqual(['Mod+W']);
    expect(getEffectiveShortcutHotkeys('thread.reopen-last-closed')).toEqual(['Mod+Shift+T']);
  });

  it('registers browser-style thread rotation defaults', () => {
    expect(getEffectiveShortcutHotkeys('thread.navigate.next')).toEqual(['Control+Tab']);
    expect(getEffectiveShortcutHotkeys('thread.navigate.previous')).toEqual(['Control+Shift+Tab']);
  });

  it('can reset one shortcut without clearing other overrides', () => {
    setShortcutOverride('search.open', 'Mod+Shift+K' as RegisterableHotkey);
    setShortcutOverride('graph.navigate.latest', 'Mod+End' as RegisterableHotkey);

    resetShortcutOverride('search.open');

    expect(getEffectiveShortcutHotkeys('search.open')).toEqual(['Mod+K']);
    expect(getShortcutDisplayLabels(getEffectiveShortcutHotkeys('graph.navigate.latest'))).toContain('End');
    expect(getShortcutOverridesSnapshot()['graph.navigate.latest']).toContain('End');
  });

  it('registers Mod+T as the default create thread shortcut', () => {
    expect(getEffectiveShortcutHotkeys('thread.create')).toEqual(['Mod+T']);
  });

  it('registers Mod+J as the default terminal dock shortcut', () => {
    expect(getEffectiveShortcutHotkeys('terminal.toggle')).toEqual(['Mod+J']);
  });
});
