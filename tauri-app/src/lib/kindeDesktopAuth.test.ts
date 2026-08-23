import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IssuerRouteTypes, generateAuthUrl } from '@kinde/js-utils';
import { openUrl } from '@tauri-apps/plugin-opener';
import { openKindeAuthInSystemBrowser, shouldUseDesktopBrowserAuth } from './kindeDesktopAuth';

vi.mock('@kinde/js-utils', () => ({
  IssuerRouteTypes: {
    login: 'login',
    register: 'registration',
  },
  PromptTypes: {
    create: 'create',
  },
  generateAuthUrl: vi.fn(async () => ({
    url: new URL('https://agentree-test.kinde.com/oauth2/auth?client_id=agentree-client'),
  })),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));

const storageValues = new Map<string, string>();
const memoryLocalStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => Array.from(storageValues.keys())[index] ?? null,
  removeItem: (key) => {
    storageValues.delete(key);
  },
  setItem: (key, value) => {
    storageValues.set(key, String(value));
  },
};

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

describe('kinde desktop auth URL generation', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_KINDE_DOMAIN', 'https://agentree-test.kinde.com');
    vi.stubEnv('VITE_KINDE_CLIENT_ID', 'agentree-client');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryLocalStorage,
    });
  });

  afterEach(() => {
    storageValues.clear();
    vi.unstubAllEnvs();
  });

  test('includes an upstream account selection prompt during login', async () => {
    await openKindeAuthInSystemBrowser('login');

    expect(generateAuthUrl).toHaveBeenCalledWith(
      'https://agentree-test.kinde.com',
      IssuerRouteTypes.login,
      expect.objectContaining({
        clientId: 'agentree-client',
        prompt: 'select_account',
      }),
    );
    expect(openUrl).toHaveBeenCalledWith('https://agentree-test.kinde.com/oauth2/auth?client_id=agentree-client');
  });
});
