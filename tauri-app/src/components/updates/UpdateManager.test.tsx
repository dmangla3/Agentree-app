// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateManager } from './UpdateManager';

const checkMock = vi.hoisted(() => vi.fn());
const relaunchMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn(() => 'toast-id'));
const removeToastMock = vi.hoisted(() => vi.fn());

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
};

describe('UpdateManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', false);
    checkMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('silently checks for updates every three hours while mounted', async () => {
    render(
      <UpdateManager>
        <div>App</div>
      </UpdateManager>
    );

    await act(async () => {
      await flushPromises();
    });

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
});
