import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import {
  registerAgentRunEffectsQueryClient,
  resetAgentRunEffectsForTest,
} from './agentRunEffects';
import { flushAgentWorkspaceRefreshesForTest } from './agentRunWorkspaceRefresh';
import { localNodeKeys } from '../hooks/useLocalNodes';

vi.mock('../lib/graphInteractionGate', () => ({
  scheduleMessagesRefreshWhenGraphIdle: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useHotSendMessageDeltas', () => ({
  catchUpHotSendMessageDeltas: vi.fn(() => Promise.resolve()),
}));

const message = (overrides: Record<string, any> = {}) => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  content: 'final',
  status: 'running',
  createdAt: '2026-05-19T09:59:00.000Z',
  updatedAt: '2026-05-19T09:59:00.000Z',
  execution_data: {},
  ...overrides,
}) as any;

const localNode = (overrides: Record<string, any> = {}) => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  syncStatus: 'local_only',
  finalizedAt: 1,
  retryAttempt: 0,
  message: message(),
  ...overrides,
}) as any;

describe('agentRun finalize effects', () => {
  let queryClient: QueryClient;
  let unregisterQueryClient: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    queryClient = new QueryClient();
    resetAgentRunEffectsForTest();
    unregisterQueryClient = registerAgentRunEffectsQueryClient(queryClient);
    vi.spyOn(queryClient, 'invalidateQueries');
    agentRunManager.clearAll();
  });

  afterEach(() => {
    flushAgentWorkspaceRefreshesForTest();
    agentRunManager.clearAll();
    unregisterQueryClient?.();
    queryClient.clear();
    resetAgentRunEffectsForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('patches message and local-node caches from a finalize ack snapshot', () => {
    queryClient.setQueryData(['messages', 'workspace-1'], [message()]);
    queryClient.setQueryData(localNodeKeys.workspace('workspace-1'), [localNode()]);

    agentRunManager.dispatch('assistant-1', {
      type: 'finalize_ack',
      status: 'completed',
      outputCommitSha: 'commit-1',
      gitBranchName: 'agent/run-1',
      commitCreated: true,
      persisted: true,
      serverAckAt: '2026-05-19T10:00:00.000Z',
    } as any, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      content: 'final',
      executionData: {},
    });

    expect(queryClient.getQueryData<any[]>(['messages', 'workspace-1'])?.[0]).toMatchObject({
      id: 'assistant-1',
      status: 'completed',
      output_commit_sha: 'commit-1',
      git_branch_name: 'agent/run-1',
      execution_data: {
        last_terminal_status: 'completed',
        output_commit_sha: 'commit-1',
        meta: {
          output_commit_sha: 'commit-1',
          commit_created: true,
        },
      },
    });
    expect(queryClient.getQueryData<any[]>(localNodeKeys.workspace('workspace-1'))?.[0].message).toMatchObject({
      id: 'assistant-1',
      status: 'completed',
      output_commit_sha: 'commit-1',
      git_branch_name: 'agent/run-1',
    });
  });

  it('applies late finalize ack cache convergence after a run is already terminal', () => {
    queryClient.setQueryData(['messages', 'workspace-1'], [message({ status: 'completed' })]);
    agentRunManager.dispatch('assistant-1', {
      type: 'terminal',
      status: 'completed',
      content: 'final',
      reason: 'completed',
      holdMs: 100,
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      content: 'final',
      executionData: {},
    });

    agentRunManager.dispatch('assistant-1', {
      type: 'finalize_ack',
      status: 'completed',
      outputCommitSha: 'commit-late',
      commitCreated: true,
    } as any);

    expect(queryClient.getQueryData<any[]>(['messages', 'workspace-1'])?.[0].output_commit_sha).toBe('commit-late');
  });

  it('patches message and local-node caches from a terminal snapshot without finalize ack', () => {
    queryClient.setQueryData(['messages', 'workspace-1'], [message({ status: 'running' })]);
    queryClient.setQueryData(localNodeKeys.workspace('workspace-1'), [localNode({
      message: message({ status: 'running' }),
    })]);

    agentRunManager.dispatch('assistant-1', {
      type: 'terminal',
      status: 'completed',
      content: 'final',
      reason: 'completed',
      holdMs: 100,
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      content: 'final',
      executionData: {},
    });

    expect(queryClient.getQueryData<any[]>(['messages', 'workspace-1'])?.[0]).toMatchObject({
      id: 'assistant-1',
      status: 'completed',
      execution_data: {
        last_terminal_status: 'completed',
      },
    });
    expect(queryClient.getQueryData<any[]>(localNodeKeys.workspace('workspace-1'))?.[0].message).toMatchObject({
      id: 'assistant-1',
      status: 'completed',
    });
  });

  it('patches terminal cache convergence even when the actor was already terminal', () => {
    queryClient.setQueryData(['messages', 'workspace-1'], [message({ status: 'running' })]);
    queryClient.setQueryData(localNodeKeys.workspace('workspace-1'), [localNode({
      message: message({ status: 'running' }),
    })]);

    agentRunManager.dispatch('assistant-1', {
      type: 'status',
      status: 'completed',
      progress: 'Completed',
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      content: 'final',
      executionData: {},
    });

    queryClient.setQueryData(['messages', 'workspace-1'], [message({ status: 'running' })]);
    queryClient.setQueryData(localNodeKeys.workspace('workspace-1'), [localNode({
      message: message({ status: 'running' }),
    })]);

    agentRunManager.dispatch('assistant-1', {
      type: 'terminal',
      status: 'completed',
      content: 'final',
      reason: 'completed',
      holdMs: 100,
    });

    expect(queryClient.getQueryData<any[]>(['messages', 'workspace-1'])?.[0].status).toBe('completed');
    expect(queryClient.getQueryData<any[]>(localNodeKeys.workspace('workspace-1'))?.[0].message.status).toBe('completed');
  });

  it('deduplicates repeated finalize effects and only refreshes commit graph when a commit sha exists', () => {
    queryClient.setQueryData(['messages', 'workspace-1'], [message()]);
    const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

    const ack = {
      type: 'finalize_ack',
      status: 'completed',
      commitCreated: false,
      persisted: true,
      serverAckAt: '2026-05-19T10:00:00.000Z',
    } as any;
    agentRunManager.dispatch('assistant-1', ack, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      content: 'final',
      executionData: {},
    });
    agentRunManager.dispatch('assistant-1', ack);

    expect(setQueryDataSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(50);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['local-nodes', 'workspace-1'],
    });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['local-commit-graph', 'workspace-1'],
      refetchType: 'active',
    });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['local-commits', 'workspace-1'],
      refetchType: 'active',
    });
  });
});
