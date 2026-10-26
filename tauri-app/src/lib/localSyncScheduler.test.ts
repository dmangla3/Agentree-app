import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushQueuedLocalSyncForTest,
  flushWorkspaceCloudBootstrap,
  flushWorkspaceCloudSync,
  ensureCloudSyncAvailable,
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
    getCloudSyncCapability: vi.fn(async () => ({ available: true, unavailableReason: null })),
    getNextLocalSyncRetryAt: vi.fn(async () => null),
  },
}));

describe('localSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(agentClient.processLocalSyncEvents).mockResolvedValue(1);
    vi.mocked(agentClient.getCloudSyncCapability).mockResolvedValue({
      available: true,
      unavailableReason: null,
    });
    vi.mocked(agentClient.getNextLocalSyncRetryAt).mockResolvedValue(null);
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
    queueLocalSyncFlush({ reason: 'workspace-renamed' });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(agentClient.processLocalSyncEvents).not.toHaveBeenCalled();
    await flushQueuedLocalSyncForTest();

    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledWith(
      'mock-token',
      'cloud-user-1',
      25,
    );
  });

  it('schedules the next retry from the native outbox summary', async () => {
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));
    vi.mocked(agentClient.getNextLocalSyncRetryAt)
      .mockResolvedValueOnce(Math.floor(Date.now() / 1000) + 10)
      .mockResolvedValue(null);

    queueLocalSyncFlush({ reason: 'workspaces-mounted' });
    await flushQueuedLocalSyncForTest();

    expect(agentClient.getNextLocalSyncRetryAt).toHaveBeenCalledWith('cloud-user-1');
    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11_500);

    expect(agentClient.processLocalSyncEvents).toHaveBeenCalledTimes(2);
  });

  it('pauses background delivery and rejects direct sync when no server is configured', async () => {
    const unavailable = {
      available: false,
      unavailableReason: 'Configure an absolute AGENTREE_SERVER_URL and restart Agentree.',
    };
    vi.mocked(agentClient.getCloudSyncCapability).mockResolvedValue(unavailable);

    queueLocalSyncFlush({ reason: 'workspaces-mounted' });
    await flushQueuedLocalSyncForTest();

    expect(agentClient.processLocalSyncEvents).not.toHaveBeenCalled();
    expect(agentClient.getNextLocalSyncRetryAt).not.toHaveBeenCalled();
    await expect(ensureCloudSyncAvailable()).rejects.toThrow(unavailable.unavailableReason);
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
