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
  const storage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
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

  it('starts a Codex refresh for a specific login profile', async () => {
    invokeMock.mockResolvedValueOnce({
      kind: 'codex',
      primary: { usedPercent: 30, resetsAt: 123, windowDurationMins: 300 },
      secondary: null,
    });

    const result = useProviderLimitsStore.getState().refreshIfStale('codex', Date.now(), 'profile-a');

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('refresh_provider_limits', {
      provider: 'codex',
      profileId: 'profile-a',
    });

    await vi.waitFor(() => {
      expect(useProviderLimitsStore.getState().byProvider['codex:profile-a']?.kind).toBe('codex');
    });
  });

  it('displays Codex provider limit windows as percent remaining', async () => {
    const { getProviderLimitWindows } = await import('./providerLimitsStore');

    const windows = getProviderLimitWindows({
      kind: 'codex',
      receivedAt: Date.now(),
      credits: null,
      limitId: null,
      limitName: null,
      planType: null,
      primary: { usedPercent: 42.4, resetsAt: 123, windowDurationMins: 300 },
      secondary: { usedPercent: 0.43, resetsAt: 456, windowDurationMins: 10_080 },
    });

    expect(windows.map((window) => [window.shortLabel, window.percent])).toEqual([
      ['5h', 58],
      ['7d', 57],
    ]);
  });

  it('displays Claude provider limit buckets as percent remaining', async () => {
    const { getProviderLimitWindows } = await import('./providerLimitsStore');

    const windows = getProviderLimitWindows({
      kind: 'claude',
      receivedAt: Date.now(),
      buckets: {
        seven_day: {
          isUsingOverage: null,
          overageDisabledReason: null,
          overageResetsAt: null,
          overageStatus: null,
          rateLimitType: 'seven_day',
          resetsAt: 123,
          status: 'allowed',
          surpassedThreshold: null,
          utilization: 43,
        },
      },
    });

    expect(windows[0]?.percent).toBe(57);
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

  it('does not refresh fresh cached limits for the same profile', () => {
    const now = Date.now();
    useProviderLimitsStore.setState({
      byProvider: {
        'codex:profile-a': {
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

    const result = useProviderLimitsStore.getState().refreshIfStale('codex', now + 1_000, 'profile-a');

    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight refreshes for the same provider', () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex')).toBe(true);
    expect(useProviderLimitsStore.getState().refreshIfStale('codex')).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in-flight refreshes by Codex profile', () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));

    expect(useProviderLimitsStore.getState().refreshIfStale('codex', Date.now(), 'profile-a')).toBe(true);
    expect(useProviderLimitsStore.getState().refreshIfStale('codex', Date.now(), 'profile-a')).toBe(false);
    expect(useProviderLimitsStore.getState().refreshIfStale('codex', Date.now(), 'profile-b')).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
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
