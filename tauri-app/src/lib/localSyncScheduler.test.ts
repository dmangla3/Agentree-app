import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushQueuedLocalSyncForTest,
  flushWorkspaceCloudBootstrap,
  flushWorkspaceCloudSync,
  queueLocalSyncFlush,
  resetLocalSyncSchedulerForTest,
} from './localSyncScheduler';
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

  it('debounces background sync and lets native workspace flags select deliverable events', async () => {
    queueLocalSyncFlush({ reason: 'workspace-list-mounted' });
    queueLocalSyncFlush({ reason: 'local-node-retryable' });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(agentClient.processLocalSyncEvents).not.toHaveBeenCalled();
    await flushQueuedLocalSyncForTest();

    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledWith(
      'mock-token',
      'cloud-user-1',
      25,
    );
  });

  it('flushes one workspace to completion before sharing', async () => {
    vi.mocked(agentClient.processLocalSyncEvents)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(2);

    await expect(flushWorkspaceCloudSync('workspace-1')).resolves.toBe(102);

    expect(agentClient.processLocalSyncEvents).toHaveBeenNthCalledWith(
      1,
      'mock-token',
      'cloud-user-1',
      100,
      'workspace-1',
      false,
    );
    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledTimes(2);
  });

  it('uploads only the bootstrap snapshot for a first share', async () => {
    vi.mocked(agentClient.processLocalSyncEvents).mockResolvedValueOnce(1);

    await expect(flushWorkspaceCloudBootstrap('workspace-1')).resolves.toBe(1);

    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledWith(
      'mock-token',
      'cloud-user-1',
      1,
      'workspace-1',
      true,
    );
  });
});
