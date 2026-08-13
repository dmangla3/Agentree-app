import { afterEach, describe, expect, it, vi } from 'vitest';

const recordPerfEventMock = vi.hoisted(() => vi.fn());
const recordFundamentalCounterMock = vi.hoisted(() => vi.fn());

vi.mock('./perfRecorder', () => ({
  recordPerfEvent: recordPerfEventMock,
}));

vi.mock('../perf/fundamentalCounters', () => ({
  recordFundamentalCounter: recordFundamentalCounterMock,
}));

import { getRuntimeActivitySnapshot, resetRuntimeActivitiesForTest } from '../perf/runtimeActivityContext';
import { runCacheRefreshOperation } from './cacheRefreshPerf';

describe('cacheRefreshPerf', () => {
  afterEach(() => {
    recordPerfEventMock.mockClear();
    recordFundamentalCounterMock.mockClear();
    resetRuntimeActivitiesForTest();
    vi.restoreAllMocks();
  });

  it('records start/end events and exposes active cache-refresh activity while running', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(30);

    await runCacheRefreshOperation({
      phase: 'local-nodes.invalidate',
      workspaceId: 'workspace-1',
      reason: 'agent-finalize-ack',
      queryKey: ['local-nodes', 'workspace-1'],
      source: 'test',
    }, async () => {
      expect(getRuntimeActivitySnapshot()).toMatchObject({
        category: 'cache-refresh',
        name: 'local-nodes.invalidate',
        details: {
          workspaceId: 'workspace-1',
          reason: 'agent-finalize-ack',
          queryKey: 'local-nodes:workspace-1',
        },
      });
    });

    expect(recordPerfEventMock).toHaveBeenCalledWith('query.cache-refresh.phase.start', {
      operationId: expect.any(Number),
      phase: 'local-nodes.invalidate',
      workspaceId: 'workspace-1',
      reason: 'agent-finalize-ack',
      queryKey: 'local-nodes:workspace-1',
      refetchType: null,
    }, { source: 'test' });
    expect(recordPerfEventMock).toHaveBeenCalledWith('query.cache-refresh.phase.end', {
      operationId: expect.any(Number),
      phase: 'local-nodes.invalidate',
      workspaceId: 'workspace-1',
      reason: 'agent-finalize-ack',
      queryKey: 'local-nodes:workspace-1',
      refetchType: null,
    }, { source: 'test', durationMs: 20 });
    expect(recordFundamentalCounterMock).toHaveBeenCalledWith('query.cache-refresh.phase', {
      phase: 'local-nodes.invalidate',
      workspaceId: 'workspace-1',
      reason: 'agent-finalize-ack',
      queryKey: 'local-nodes:workspace-1',
      refetchType: null,
    }, 20);
  });
});
