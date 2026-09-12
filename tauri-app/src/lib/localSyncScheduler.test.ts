import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushQueuedLocalSyncForTest, queueLocalSyncFlush, resetLocalSyncSchedulerForTest } from './localSyncScheduler';
import { getAccessToken } from './authSession';
import { agentClient } from './agentClient';
import { useAuthStore } from '../stores/authStore';

vi.mock('./authSession', () => ({
  getAccessToken: vi.fn(async () => 'mock-token'),
}));

vi.mock('./agentClient', () => ({
  agentClient: {
    processLocalSyncEvents: vi.fn(async () => 1),
  },
}));

describe('localSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStore.getState().setUser({
      id: 'cloud-user-1',
      email: 'cloud@example.com',
      name: 'Cloud User',
    });
    useAuthStore.getState().setDesktopSession({
      accessToken: 'mock-token',
      idToken: 'mock-id-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: null,
    });
    resetLocalSyncSchedulerForTest();
  });

  afterEach(() => {
    resetLocalSyncSchedulerForTest();
    useAuthStore.getState().clearSession();
    vi.useRealTimers();
  });

  it('debounces UI-triggered sync flushes into one background server sync', async () => {
    queueLocalSyncFlush({ reason: 'workspace-list-mounted' });
    queueLocalSyncFlush({ reason: 'local-node-retryable' });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(agentClient.processLocalSyncEvents).not.toHaveBeenCalled();

    await flushQueuedLocalSyncForTest();

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledTimes(1);
    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledWith('mock-token', 'cloud-user-1', 25);
  });
});
