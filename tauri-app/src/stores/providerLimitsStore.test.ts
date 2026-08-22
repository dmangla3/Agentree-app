import { invoke } from '@tauri-apps/api/core';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { useProviderLimitsStore as ProviderLimitsStore } from './providerLimitsStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
let useProviderLimitsStore: typeof ProviderLimitsStore;

const installMemoryLocalStorage = () => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, String(value));
      },
    },
  });
};

describe('providerLimitsStore background refresh', () => {
  beforeEach(async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.useRealTimers();
    vi.resetModules();
    installMemoryLocalStorage();
    invokeMock.mockReset();
    ({ useProviderLimitsStore } = await import('./providerLimitsStore'));
    useProviderLimitsStore.setState({ byProvider: {} });
  });

  it('starts a Codex refresh when cached limits are missing', async () => {
    invokeMock.mockResolvedValueOnce({
      kind: 'codex',
      primary: { usedPercent: 42, resetsAt: 123, windowDurationMins: 300 },
      secondary: null,
    });

    const result = useProviderLimitsStore.getState().refreshIfStale('codex');

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('refresh_provider_limits', { provider: 'codex' });

    await vi.waitFor(() => {
      expect(useProviderLimitsStore.getState().byProvider.codex?.kind).toBe('codex');
    });
  });

  it('does not refresh fresh cached limits', () => {
    const now = Date.now();
    useProviderLimitsStore.setState({
      byProvider: {
        codex: {
          kind: 'codex',
          receivedAt: now,
          credits: null,
          limitId: null,
          limitName: null,
          planType: null,
          primary: { usedPercent: 51, resetsAt: null, windowDurationMins: 300 },
          secondary: null,
        },
      },
    });

    const result = useProviderLimitsStore.getState().refreshIfStale('codex', now + 1_000);

    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight refreshes for the same provider', () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex')).toBe(true);
    expect(useProviderLimitsStore.getState().refreshIfStale('codex')).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failed refresh instead of retrying on every picker open', async () => {
    const now = Date.now();
    invokeMock.mockRejectedValue(new Error('Codex login missing'));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex', now)).toBe(true);
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex', now + 1_000)).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('times out a hung refresh so later picker opens can try again', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    invokeMock.mockReturnValue(new Promise(() => undefined));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex', now)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_001);

    expect(useProviderLimitsStore.getState().refreshIfStale('codex', now + 11_000)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
