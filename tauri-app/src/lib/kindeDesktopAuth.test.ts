import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IssuerRouteTypes, generateAuthUrl } from '@kinde/js-utils';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAuthStore } from '../stores/authStore';
import {
  openKindeAuthInSystemBrowser,
  persistDesktopSession,
  refreshDesktopTokens,
  restoreDesktopCloudSession,
  shouldUseDesktopBrowserAuth,
} from './kindeDesktopAuth';

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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
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

const toTestIdToken = (subject = 'user-1') => {
  const payload = btoa(JSON.stringify({
    email: 'user@example.com',
    given_name: 'Test User',
    sub: subject,
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
};

const setTauriWindowMarker = () => {
  const fakeWindow = {};
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(fakeWindow, '__TAURI__', {
    configurable: true,
    value: {},
  });
};

describe('kinde desktop auth runtime detection', () => {
  test('uses desktop browser auth when Tauri exposes the legacy window marker', () => {
    setTauriWindowMarker();

    expect(shouldUseDesktopBrowserAuth()).toBe(true);

    Reflect.deleteProperty(globalThis, 'window');
  });
});

describe('kinde desktop session persistence', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    vi.mocked(invoke).mockReset();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryLocalStorage,
    });
  });

  afterEach(() => {
    useAuthStore.getState().clearSession();
    storageValues.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('does not expose a session until secure storage confirms the write', async () => {
    let finishWrite: (() => void) | undefined;
    vi.mocked(invoke).mockImplementation(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const tokens = {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      idToken: toTestIdToken(),
      refreshToken: 'refresh-token',
    };

    const save = persistDesktopSession(tokens);

    expect(useAuthStore.getState().desktopSession).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();

    finishWrite?.();
    await save;

    expect(useAuthStore.getState().desktopSession).toEqual(tokens);
    expect(useAuthStore.getState().user?.id).toBe('user-1');
  });

  test('leaves the app logged out when secure storage rejects the write', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('secure storage unavailable'));

    await expect(persistDesktopSession({
      accessToken: 'access-token',
      expiresAt: null,
      idToken: toTestIdToken(),
      refreshToken: 'refresh-token',
    })).rejects.toThrow('secure storage unavailable');

    expect(useAuthStore.getState().desktopSession).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  test('restores a valid session from native secure storage', async () => {
    setTauriWindowMarker();
    const session = {
      accessToken: 'restored-access-token',
      expiresAt: Date.now() + 60_000,
      idToken: toTestIdToken('restored-user'),
      refreshToken: 'restored-refresh-token',
    };
    vi.mocked(invoke).mockResolvedValue(JSON.stringify(session));

    await restoreDesktopCloudSession();

    expect(invoke).toHaveBeenCalledWith('read_agentree_cloud_session');
    expect(useAuthStore.getState().desktopSession).toEqual(session);
    expect(useAuthStore.getState().user?.id).toBe('restored-user');
  });

  test('deletes a rejected refresh session so it cannot return after restart', async () => {
    vi.stubEnv('VITE_KINDE_DOMAIN', 'https://agentree-test.kinde.com');
    vi.stubEnv('VITE_KINDE_CLIENT_ID', 'agentree-client');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('refresh rejected', { status: 401 })));
    vi.mocked(invoke).mockResolvedValue(undefined);
    useAuthStore.getState().setDesktopSession({
      accessToken: 'expired-access-token',
      expiresAt: 0,
      idToken: toTestIdToken(),
      refreshToken: 'rejected-refresh-token',
    });
    useAuthStore.getState().setUser({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
    });

    await expect(refreshDesktopTokens(true)).rejects.toThrow('Token refresh failed: 401');

    expect(invoke).toHaveBeenCalledWith('clear_agentree_cloud_session');
    expect(useAuthStore.getState().desktopSession).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().authErrorReason).toContain('expired');
  });

  test('denies an expired session locally even if secure storage cannot be cleared', async () => {
    vi.stubEnv('VITE_KINDE_DOMAIN', 'https://agentree-test.kinde.com');
    vi.stubEnv('VITE_KINDE_CLIENT_ID', 'agentree-client');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('refresh rejected', { status: 401 })));
    vi.mocked(invoke).mockRejectedValue(new Error('secure storage locked'));
    useAuthStore.getState().setDesktopSession({
      accessToken: 'expired-access-token',
      expiresAt: 0,
      idToken: toTestIdToken(),
      refreshToken: 'rejected-refresh-token',
    });
    useAuthStore.getState().setUser({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
    });

    await expect(refreshDesktopTokens(true)).rejects.toThrow('Token refresh failed: 401');

    expect(useAuthStore.getState().desktopSession).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().authErrorReason).toContain('expired');
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
