import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markGraphInteractionEnd,
  markGraphInteractionStart,
  resetGraphInteractionGateForTest,
  scheduleLocalCommitGraphRefreshWhenGraphIdle,
  scheduleMessagesRefreshWhenGraphIdle,
} from './graphInteractionGate';

vi.mock('./cacheRefreshPerf', () => ({
  runCacheRefreshOperation: vi.fn((_input, operation) => operation()),
}));

vi.mock('./perfRecorder', () => ({
  recordPerfEvent: vi.fn(),
}));

import { recordPerfEvent } from './perfRecorder';

describe('graphInteractionGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.mocked(recordPerfEvent).mockClear();
    resetGraphInteractionGateForTest();
  });

  afterEach(() => {
    resetGraphInteractionGateForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('flushes pending message refreshes when graph interaction becomes idle', async () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;

    markGraphInteractionStart('drag');
    void scheduleMessagesRefreshWhenGraphIdle(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
    });

    vi.advanceTimersByTime(500);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    markGraphInteractionEnd('drag');
    await vi.advanceTimersByTimeAsync(900);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['messages', 'workspace-1'],
      refetchType: 'none',
    });
  });

  it('force-flushes message refreshes after max wait while interaction remains active', async () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;

    markGraphInteractionStart('drag');
    void scheduleMessagesRefreshWhenGraphIdle(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['messages', 'workspace-1'],
      refetchType: 'none',
    });
    expect(recordPerfEvent).toHaveBeenCalledWith('query.graph-interaction-gate.force-flush', {
      pendingMessageRefreshCount: 1,
      pendingStructuralRefreshCount: 0,
      pendingLocalCommitGraphRefreshCount: 0,
      oldestPendingAgeMs: 3000,
    }, { source: 'graphInteractionGate' });
  });

  it('force-flushes commit graph refetches after max wait while interaction remains active', async () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;

    markGraphInteractionStart('drag');
    void scheduleLocalCommitGraphRefreshWhenGraphIdle(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(queryClient.refetchQueries).toHaveBeenCalledWith({
      queryKey: ['local-commit-graph', 'workspace-1'],
      type: 'active',
    });
    expect(queryClient.refetchQueries).toHaveBeenCalledWith({
      queryKey: ['local-commits', 'workspace-1'],
      type: 'active',
    });
  });
});
