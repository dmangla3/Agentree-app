// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateManager, UpdateToolbarButton } from './UpdateManager';

const checkMock = vi.hoisted(() => vi.fn());
const getVersionMock = vi.hoisted(() => vi.fn());
const relaunchMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn(() => 'toast-id'));
const removeToastMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock,
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}));

vi.mock('../Toast', () => ({
  useToast: () => ({
    addToast: addToastMock,
    removeToast: removeToastMock,
  }),
}));

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const installMemoryLocalStorage = () => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  });
};

const renderManager = (withToolbar = false) =>
  render(
    <UpdateManager>
      {withToolbar ? <UpdateToolbarButton /> : <div>App</div>}
    </UpdateManager>
  );

describe('UpdateManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_AGENTREE_OFFICIAL_CLOUD', 'true');
    installMemoryLocalStorage();
    getVersionMock.mockResolvedValue('0.3.0');
    checkMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('checks on startup and every three hours while mounted', async () => {
    renderManager();

    await act(flushPromises);
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3 * 60 * 60 * 1000 - 1);
      await flushPromises();
    });
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushPromises();
    });
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('checks after the app returns to focus without polling repeatedly', async () => {
    renderManager();
    await act(flushPromises);

    await act(async () => {
      vi.advanceTimersByTime(15 * 60 * 1000 - 1);
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed background check as soon as connectivity returns', async () => {
    checkMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderManager();
    await act(flushPromises);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await flushPromises();
    });

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith('[Updater] Update check failed', expect.any(Error));
  });

  it('still checks the updater if app-version metadata cannot be read', async () => {
    getVersionMock.mockRejectedValue(new Error('version unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderManager();
    await act(flushPromises);

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[Updater] Failed to read the current app version', expect.any(Error));
  });

  it('persists an available update and keeps it discoverable in the toolbar', async () => {
    checkMock.mockResolvedValue({
      currentVersion: '0.3.0',
      version: '0.3.1',
      body: 'Bug fixes',
      downloadAndInstall: vi.fn(),
    });
    renderManager(true);
    await act(flushPromises);

    expect(screen.getByRole('button', { name: 'Install version 0.3.1' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('agentree.updater.last-check.v1') ?? '{}')).toMatchObject({
      outcome: 'available',
      currentVersion: '0.3.0',
      availableVersion: '0.3.1',
    });
  });

  it('downloads an available update and relaunches the app', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      currentVersion: '0.3.0',
      version: '0.3.1',
      body: null,
      downloadAndInstall,
    });
    renderManager(true);
    await act(flushPromises);

    fireEvent.click(screen.getByRole('button', { name: 'Install version 0.3.1' }));
    await act(flushPromises);

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it('shows manual check failures while recording silent failures only in diagnostics', async () => {
    checkMock.mockRejectedValue(new Error('feed unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderManager(true);
    await act(flushPromises);

    expect(addToastMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await act(flushPromises);

    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Update check failed',
      description: 'feed unavailable',
    }));
    expect(JSON.parse(window.localStorage.getItem('agentree.updater.last-check.v1') ?? '{}')).toMatchObject({
      outcome: 'failed',
      error: 'feed unavailable',
    });
  });

  it('hides updater controls and never checks from community builds', async () => {
    vi.stubEnv('VITE_AGENTREE_OFFICIAL_CLOUD', 'false');
    renderManager(true);
    await act(flushPromises);

    expect(screen.queryByRole('button', { name: /updates|version/i })).toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });
});
