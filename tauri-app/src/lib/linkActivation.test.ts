// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Command } from '@tauri-apps/plugin-shell';
import { commands } from '../generated/tauri-bindings';
import { activateLink, resolveLinkActivationTarget } from './linkActivation';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => ({
      execute: vi.fn(async () => ({ code: 0 })),
    })),
  },
}));

vi.mock('../generated/tauri-bindings', () => ({
  commands: {
    getAvailableEditors: vi.fn(async () => [
      { name: 'Finder', command: 'open', icon_key: 'finder' },
      { name: 'Cursor', command: 'cursor', icon_key: 'cursor' },
    ]),
  },
}));

describe('resolveLinkActivationTarget', () => {
  it('keeps http links external', () => {
    expect(resolveLinkActivationTarget('https://example.com/docs')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('blocks unsafe schemes', () => {
    expect(resolveLinkActivationTarget('javascript:alert(1)')).toEqual({
      kind: 'blocked',
      reason: 'unsafe-scheme',
    });
  });

  it('resolves relative file links against the workspace repo path', () => {
    expect(resolveLinkActivationTarget('src/App.tsx:12:3', '/Users/example/project')).toEqual({
      kind: 'file',
      path: '/Users/example/project/src/App.tsx',
      line: 12,
      column: 3,
    });
  });

  it('resolves file URLs with line suffixes', () => {
    expect(resolveLinkActivationTarget('file:///Users/example/project/src/App.tsx:12')).toEqual({
      kind: 'file',
      path: '/Users/example/project/src/App.tsx',
      line: 12,
      column: null,
    });
  });
});

describe('activateLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens web links with the Tauri opener', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await activateLink('https://example.com');

    expect(openUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('opens file links in the first available non-Finder editor', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await activateLink('src/App.tsx:12', '/Users/example/project');

    expect(commands.getAvailableEditors).toHaveBeenCalled();
    expect(Command.create).toHaveBeenCalledWith('cursor', [
      '--goto',
      '/Users/example/project/src/App.tsx:12',
    ]);
  });

  it('uses xdg-open only as a fallback when no editor CLI is available', async () => {
    vi.mocked(commands.getAvailableEditors).mockResolvedValueOnce([
      { name: 'Default App', command: 'xdg-open', icon_key: 'default-app' },
    ]);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await activateLink('src/App.tsx:12', '/Users/example/project');

    expect(Command.create).toHaveBeenCalledWith('xdg-open', [
      '/Users/example/project/src/App.tsx',
    ]);
  });
});
