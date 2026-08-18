import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushAgentWorkspaceRefreshesForTest,
  requestAgentWorkspaceRefresh,
} from './agentRunWorkspaceRefresh';

vi.mock('../lib/graphInteractionGate', () => ({
  isGraphInteractionGateIdle: vi.fn(() => true),
  scheduleMessagesRefreshWhenGraphIdle: vi.fn(() => Promise.resolve()),
  scheduleLocalCommitGraphRefreshWhenGraphIdle: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useHotSendMessageDeltas', () => ({
  catchUpHotSendMessageDeltas: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/perfRecorder', () => ({
  recordPerfEvent: vi.fn(),
}));

import {
  isGraphInteractionGateIdle,
  scheduleLocalCommitGraphRefreshWhenGraphIdle,
  scheduleMessagesRefreshWhenGraphIdle,
} from '../lib/graphInteractionGate';
import { catchUpHotSendMessageDeltas } from '../hooks/useHotSendMessageDeltas';
import { recordPerfEvent } from '../lib/perfRecorder';
import { useRunStatusStore } from '../stores/runStatusStore';

describe('agentRunWorkspaceRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T00:00:00.000Z'));
    vi.mocked(isGraphInteractionGateIdle).mockReset();
    vi.mocked(isGraphInteractionGateIdle).mockReturnValue(true);
    vi.mocked(scheduleMessagesRefreshWhenGraphIdle).mockClear();
    vi.mocked(scheduleLocalCommitGraphRefreshWhenGraphIdle).mockClear();
    vi.mocked(catchUpHotSendMessageDeltas).mockClear();
    vi.mocked(recordPerfEvent).mockClear();
    useRunStatusStore.getState().clearAllRunStatus();
    flushAgentWorkspaceRefreshesForTest();
  });

  afterEach(() => {
    flushAgentWorkspaceRefreshesForTest();
    useRunStatusStore.getState().clearAllRunStatus();
    vi.useRealTimers();
  });

  it('coalesces local-node and message refreshes by workspace', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-terminal' });
    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-finalize-ack' });

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
      refetchType: 'none',
    });
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledTimes(1);
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-terminal+agent-finalize-ack' },
    );
  });

  it('coalesces commit graph invalidation and defers active refetch off the finalize path', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', { reason: 'agent-terminal' });
    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
      includeCommitGraph: true,
      catchUpHotDeltas: true,
    });

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-commit-graph', 'workspace-1'],
      refetchType: 'none',
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-commits', 'workspace-1'],
      refetchType: 'none',
    });
    expect(queryClient.refetchQueries).not.toHaveBeenCalledWith({
      queryKey: ['local-commit-graph', 'workspace-1'],
      type: 'active',
    });
    expect(queryClient.refetchQueries).not.toHaveBeenCalledWith({
      queryKey: ['local-commits', 'workspace-1'],
      type: 'active',
    });
    expect(recordPerfEvent).toHaveBeenCalledWith('query.local-commit-graph.refresh', {
      workspaceId: 'workspace-1',
      reason: 'agent-terminal+agent-finalize-ack',
      refetchActive: false,
      refetchMode: 'deferred',
    }, { source: 'agentRunWorkspaceRefresh' });
    expect(catchUpHotSendMessageDeltas).toHaveBeenCalledWith(queryClient, 'workspace-1');

    vi.advanceTimersByTime(900);

    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    expect(scheduleLocalCommitGraphRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-terminal+agent-finalize-ack' },
    );
  });

  it('waits for active run state before scheduling commit graph reconciliation', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
      progress: 'Running',
    });

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
      includeCommitGraph: true,
    });

    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(900);

    expect(scheduleLocalCommitGraphRefreshWhenGraphIdle).not.toHaveBeenCalled();
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();

    useRunStatusStore.getState().clearRunStatus('assistant-1');
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(900);

    expect(scheduleLocalCommitGraphRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-finalize-ack' },
    );
  });

  it('waits for graph interaction idle before invalidating workspace caches', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;
    vi.mocked(isGraphInteractionGateIdle).mockReturnValue(false);

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
      includeCommitGraph: true,
      catchUpHotDeltas: true,
    });

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(scheduleMessagesRefreshWhenGraphIdle).not.toHaveBeenCalled();
    expect(catchUpHotSendMessageDeltas).not.toHaveBeenCalled();
    expect(recordPerfEvent).toHaveBeenCalledWith('query.agent-workspace-refresh.wait-responsive-idle', {
      workspaceId: 'workspace-1',
      reason: 'agent-finalize-ack',
      includeCommitGraph: true,
      catchUpHotDeltas: true,
      pendingAgeMs: 50,
      activeRunCount: 0,
      waitForActiveRun: false,
      waitForGraphIdle: true,
    }, { source: 'agentRunWorkspaceRefresh' });

    vi.advanceTimersByTime(250);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    vi.mocked(isGraphInteractionGateIdle).mockReturnValue(true);
    vi.advanceTimersByTime(250);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
      refetchType: 'none',
    });
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-finalize-ack' },
    );
    expect(catchUpHotSendMessageDeltas).toHaveBeenCalledWith(queryClient, 'workspace-1');
  });

  it('forces workspace cache refresh after a bounded graph-busy wait', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;
    vi.mocked(isGraphInteractionGateIdle).mockReturnValue(false);

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
    });

    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(3_000);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
      refetchType: 'none',
    });
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-finalize-ack' },
    );
  });

  it('forces workspace cache refresh after a bounded active-run wait', () => {
    const queryClient = {
      invalidateQueries: vi.fn(() => Promise.resolve()),
      refetchQueries: vi.fn(() => Promise.resolve()),
    } as any;
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
      progress: 'Running',
    });

    requestAgentWorkspaceRefresh(queryClient, 'workspace-1', {
      reason: 'agent-finalize-ack',
    });

    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(2_750);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
      refetchType: 'none',
    });
    expect(scheduleMessagesRefreshWhenGraphIdle).toHaveBeenCalledWith(
      queryClient,
      'workspace-1',
      { reason: 'agent-finalize-ack' },
    );
  });
});
