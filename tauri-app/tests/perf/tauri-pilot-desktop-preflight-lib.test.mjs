import { describe, expect, it } from 'vitest';
import {
  assertVisibleFocusedWebviewSource,
  parseAgentreeDesktopProcessInventory,
} from './tauri-pilot-desktop-preflight-lib.mjs';

const withWebviewGlobals = (document, callback) => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    globalThis.document = document;
    globalThis.location = { href: 'tauri://localhost/' };
    return callback();
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
};

const evaluateVisibleFocusedWebviewSource = () => Function(`return (${assertVisibleFocusedWebviewSource});`)();

describe('Tauri Pilot desktop preflight helpers', () => {
  it('separates packaged and dev Agentree processes', () => {
    const inventory = parseAgentreeDesktopProcessInventory([
      '123 /Users/example/work/example/Agentree/tauri-app/src-tauri/target/debug/agentree',
      '456 /Applications/agentree.app/Contents/MacOS/agentree',
      '789 node unrelated',
    ].join('\n'));

    expect(inventory.devRuntime).toHaveLength(1);
    expect(inventory.packaged).toHaveLength(1);
  });

  it('classifies packaged and dev Agentree processes with args', () => {
    const inventory = parseAgentreeDesktopProcessInventory([
      '123 /Users/example/work/example/Agentree/tauri-app/src-tauri/target/debug/agentree --dev-flag',
      '456 /Applications/agentree.app/Contents/MacOS/agentree --packaged-flag',
      '789 node unrelated',
    ].join('\n'));

    expect(inventory.devRuntime).toHaveLength(1);
    expect(inventory.devRuntime[0].command).toContain('--dev-flag');
    expect(inventory.packaged).toHaveLength(1);
    expect(inventory.packaged[0].command).toContain('--packaged-flag');
  });

  it('fails focused-webview preflight when document focus is false', () => {
    withWebviewGlobals({
      visibilityState: 'visible',
      hidden: false,
      hasFocus: () => false,
    }, () => {
      expect(evaluateVisibleFocusedWebviewSource).toThrow(/desktop webview preflight failed/);
    });
  });

  it('rejects hidden webviews', () => {
    withWebviewGlobals({
      visibilityState: 'hidden',
      hidden: true,
      hasFocus: () => false,
    }, () => {
      expect(evaluateVisibleFocusedWebviewSource).toThrow(/desktop webview preflight failed/);
    });
  });

  it('returns state when focused webview preflight passes', () => {
    withWebviewGlobals({
      visibilityState: 'visible',
      hidden: false,
      hasFocus: () => true,
    }, () => {
      expect(evaluateVisibleFocusedWebviewSource()).toEqual({
        visibility: 'visible',
        hidden: false,
        hasFocus: true,
        url: 'tauri://localhost/',
      });
    });
  });
});
