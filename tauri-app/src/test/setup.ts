import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from '../mocks/node';

const installMemoryLocalStorage = () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
};

class MockResizeObserver implements ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../lib/authSession', () => ({
  getAccessToken: vi.fn(async () => 'mock-token'),
  getOptionalCloudAuthToken: vi.fn(async () => 'mock-token'),
  handleSessionExpired: vi.fn(),
  configureAuthSession: vi.fn(),
  configureDesktopAuthSession: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackWorkspaceCreated: vi.fn(),
}));

beforeAll(() => {
  installMemoryLocalStorage();
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: MockResizeObserver,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: MockResizeObserver,
  });
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  if (typeof window?.localStorage?.clear === 'function') {
    window.localStorage.clear();
  }
  server.resetHandlers();
  vi.clearAllMocks();
});

afterAll(() => {
  server.close();
});
