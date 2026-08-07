import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushAgentWorkspaceRefreshesForTest,
  requestAgentWorkspaceRefresh,
} from './agentRunWorkspaceRefresh';

vi.mock('../lib/graphInteractionGate', () => ({
  scheduleMessagesRefreshWhenGraphIdle: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useHotSendMessageDeltas', () => ({
  catchUpHotSendMessageDeltas: vi.fn(() => Promise.resolve()),
}));

import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { catchUpHotSendMessageDeltas } from '../hooks/useHotSendMessageDeltas';

describe('agentRunWorkspaceRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(scheduleMessagesRefreshWhenGraphIdle).mockClear();
    vi.mocked(catchUpHotSendMessageDeltas).mockClear();
    flushAgentWorkspaceRefreshesForTest();
  });

  afterEach(() => {
    flushAgentWorkspaceRefreshesForTest();
    vi.useRealTimers();
  });

  it('coalesces local-node and message refreshes by workspace', () => {
    const queryClient = { invalidateQueries: vi.fn() } as any;

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-terminal' });
    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-finalize-ack' });

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
    });
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledTimes(1);
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-terminal+agent-finalize-ack' },
    );
  });

  it('coalesces commit graph refresh and hot delta catchup flags', () => {
    const queryClient = { invalidateQueries: vi.fn() } as any;

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-terminal' });
    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
      includeCommitGraph: true,
      catchUpHotDeltas: true,
    });

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-commit-graph', 'workspace-1'],
      refetchType: 'active',
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-commits', 'workspace-1'],
      refetchType: 'active',
    });
    expect(catchUpHotSendMessageDeltas).toHaveBeenCalledWith(queryClient, 'workspace-1');
  });
});
